"""Private bounded RPC to the matching SDK backend bundled with Touba."""
import atexit
import asyncio
from concurrent.futures import Future, ThreadPoolExecutor
import contextvars
import inspect
import json
import math
import os
import subprocess
import threading
from ._host_context import execution_context
from .provider_errors import ToubaAgentDecisionProviderError, provider_diagnostic_details, provider_error_code
from ._engine_command import resolve_engine_command

MAX_BYTES = 8 * 1024 * 1024


def _error(code="PythonHostUnavailable", details=None):
    return ToubaAgentDecisionProviderError(code, "Touba SDK backend operation failed", details)


class MicroUnits(int):
    """Private exact-integer wire marker, not a language numeric type."""


class Backend:
    def __init__(self):
        command = json.loads(os.environ.get("TOUBA_SDK_SERVICE_COMMAND", '["touba","sdk","service"]'))
        if not isinstance(command, list) or not command or any(not isinstance(x, str) or not x or "\0" in x for x in command):
            raise _error("InvalidDecisionProviderOptions")
        try:
            executable, arguments, environment = resolve_engine_command(command[0], command[1:], os.getcwd(), os.environ)
        except ValueError:
            raise _error("EngineBatchLauncherUnsupported") from None
        self.lock = threading.RLock()
        self.pending, self.callbacks = {}, {}
        self.sequence, self.closed = 0, False
        self.executor = ThreadPoolExecutor(max_workers=32)
        self.child = subprocess.Popen([executable, *arguments], env=environment,
                                      stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                      shell=False, bufsize=0)
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._stderr, daemon=True).start()

    def pack(self, value, owned_callbacks=None, depth=0):
        if depth > 100:
            raise _error("PythonHostPayloadInvalid")
        if isinstance(value, Remote):
            if value.backend is not self or value.closed:
                raise _error("InvalidDecisionProviderOptions")
            return {"t": "handle", "v": value.handle}
        if isinstance(value, MicroUnits):
            return {"t": "integer", "v": str(value)}
        if value is None or type(value) in (str, bool) or (type(value) in (int, float) and math.isfinite(value) and abs(value) <= 2**53 - 1):
            return {"t": "value", "v": value}
        if type(value) is int:
            return {"t": "integer", "v": str(value)}
        if isinstance(value, (list, tuple)):
            return {"t": "array", "v": [self.pack(item, owned_callbacks, depth + 1) for item in value]}
        if isinstance(value, dict) and all(isinstance(key, str) for key in value):
            return {"t": "object", "v": [[key, self.pack(item, owned_callbacks, depth + 1)] for key, item in value.items()]}
        if callable(value) and owned_callbacks is not None:
            with self.lock:
                if len(self.callbacks) >= 1024:
                    raise _error("PythonHostPayloadInvalid")
                self.sequence += 1
                self.callbacks[self.sequence] = value
                owned_callbacks.add(self.sequence)
                return {"t": "callback", "v": self.sequence}
        raise _error("PythonHostPayloadInvalid")

    def release_callbacks(self, identifiers):
        with self.lock:
            for identifier in identifiers:
                self.callbacks.pop(identifier, None)
            identifiers.clear()

    def unpack(self, node):
        kind, value = node["t"], node["v"]
        if kind == "value":
            return value
        if kind == "integer":
            return int(value)
        if kind == "array":
            return [self.unpack(item) for item in value]
        if kind == "object":
            return {key: self.unpack(item) for key, item in value}
        raise _error("PythonHostPayloadInvalid")

    def send(self, value):
        data = (json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n").encode()
        if len(data) > MAX_BYTES:
            raise _error("PythonHostPayloadInvalid")
        with self.lock:
            if self.closed:
                raise _error()
            self.child.stdin.write(data)
            self.child.stdin.flush()

    def request(self, **message):
        with self.lock:
            if self.closed or len(self.pending) >= 32:
                raise _error()
            self.sequence += 1
            request_id = self.sequence
            future = Future()
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = None
            timer = threading.Timer(180, lambda: self.close("PythonHostTimeout"))
            timer.daemon = True
            self.pending[request_id] = (future, loop, contextvars.copy_context(), timer)
            timer.start()
            try:
                self.send({"id": request_id, **message})
            except BaseException:
                timer.cancel(); self.pending.pop(request_id, None)
                raise
            return future

    def _callback(self, message, state):
        try:
            _, loop, context, _ = state
            if message["target"] in ("cost", "provider_metadata"):
                observer = context.get(execution_context)
                function = observer if message["target"] == "cost" else lambda value: observer(value, "provider_metadata")
            else:
                function = self.callbacks[message["target"]]
            if not callable(function):
                raise _error()
            arguments = self.unpack(message["args"])

            async def invoke():
                result = function(*arguments)
                return await result if inspect.isawaitable(result) else result

            if loop and loop.is_running():
                result = context.run(asyncio.run_coroutine_threadsafe, invoke(), loop).result(timeout=180)
            else:
                result = context.run(asyncio.run, invoke())
            self.send({"callback_reply": message["callback"], "result": self.pack(result)})
        except BaseException as error:
            code = provider_error_code(error)
            try:
                self.send({"callback_reply": message["callback"], "error": {"code": code,
                    "details": provider_diagnostic_details(getattr(error, "details", None))}})
            except BaseException:
                self.close()

    def _read(self):
        try:
            while True:
                raw = self.child.stdout.readline(MAX_BYTES + 1)
                if not raw:
                    break
                if len(raw) > MAX_BYTES or not raw.endswith(b"\n"):
                    raise _error("PythonHostPayloadInvalid")
                message = json.loads(raw)
                with self.lock:
                    if "callback" in message:
                        state = self.pending.get(message.get("parent"))
                        if state is None:
                            raise _error("PythonHostPayloadInvalid")
                        self.executor.submit(self._callback, message, state)
                    else:
                        state = self.pending.pop(message["id"], None)
                        if state is None:
                            raise _error("PythonHostPayloadInvalid")
                        future, _, _, timer = state
                        timer.cancel()
                        if future.cancelled():
                            continue
                        if "error" in message:
                            future.set_exception(_error(message["error"].get("code", "PythonHostUnavailable"), message["error"].get("details")))
                        else:
                            future.set_result(self.unpack(message["result"]))
        except BaseException:
            pass
        finally:
            self.close()

    def _stderr(self):
        total = 0
        while True:
            chunk = self.child.stderr.read(4096)
            if not chunk:
                return
            total += len(chunk)
            if total > MAX_BYTES:
                self.close("PythonHostPayloadInvalid"); return

    def close(self, code="PythonHostUnavailable"):
        with self.lock:
            if self.closed:
                return
            self.closed = True
            for future, _, _, timer in self.pending.values():
                timer.cancel()
                if not future.done():
                    future.set_exception(_error(code))
            self.pending.clear()
            try:
                self.child.stdin.close()
            except OSError:
                pass
        try:
            self.child.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self.child.kill(); self.child.wait()
        self.executor.shutdown(wait=False, cancel_futures=True)


_backend, _backend_lock = None, threading.Lock()


def backend():
    global _backend
    with _backend_lock:
        if _backend is None:
            _backend = Backend()
        if _backend.closed:
            # No implicit restart: RAM history and in-flight outcomes would be lost.
            raise _error()
        return _backend


def close_backend():
    if _backend is not None:
        _backend.close()


atexit.register(close_backend)


class Remote:
    def __init__(self, kind, options):
        self.backend = backend()
        self.closed = False
        self.callbacks = set()
        try:
            self.handle = self.backend.request(method="create", kind=kind, options=self.backend.pack(options, self.callbacks)).result(timeout=181)
        except BaseException:
            self.backend.release_callbacks(self.callbacks)
            raise

    def call(self, operation, *args):
        if self.closed:
            raise _error("InvalidDecisionProviderOptions")
        callbacks = set()
        try:
            future = self.backend.request(method="call", handle=self.handle, operation=operation,
                                          args=self.backend.pack(args, callbacks), execution=execution_context.get() is not None)
            future.add_done_callback(lambda _: self.backend.release_callbacks(callbacks))
            return future
        except BaseException:
            self.backend.release_callbacks(callbacks)
            raise

    async def __call__(self, *args):
        return await asyncio.wrap_future(self.call("invoke", *args))

    def close(self):
        if not self.closed:
            self.backend.request(method="release", handle=self.handle).result(timeout=181)
            self.backend.release_callbacks(self.callbacks)
            self.closed = True
