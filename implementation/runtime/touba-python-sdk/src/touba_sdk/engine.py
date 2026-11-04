"""Bounded local CLI transport shared by the sync and asyncio APIs."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import hashlib
import json
import math
import os
from pathlib import Path
import signal
import tempfile
from threading import Event
from typing import Any, Literal, Mapping, Sequence, TypedDict, Unpack
from ._engine_command import resolve_engine_command
from ._trace_reference import validate_reference, validate_page
from ._version import VERSION

MAX_OUTPUT = 32 * 1024 * 1024


class ToubaEngineError(Exception):
    def __init__(self, phase: str, code: str, details: Mapping[str, Any] | None = None):
        super().__init__(f"Touba {phase}: {code}")
        self.phase = phase
        self.code = code
        self.details = dict(details or {})


@dataclass(frozen=True)
class CompileResult:
    air_json: str
    air_document: dict[str, Any]


@dataclass(frozen=True)
class RunResult:
    status: Literal["success", "stopped", "cancelled"]
    reason: str
    result: Any
    messages: list[dict[str, str]]
    trace: dict[str, Any] | None
    pending_interaction: dict[str, Any] | None = None
    pending_interactions: list[dict[str, str]] = field(default_factory=list)
    trace_reference: dict[str, Any] | None = None


class RunOptions(TypedDict, total=False):
    project: str
    profile: str
    source: str
    air: str
    air_json: str | dict[str, Any]
    entry_ref: str
    inputs: dict[str, Any]
    manifest: str
    secrets: str
    resource_bindings: str
    require_resource_bindings: bool
    supply_chain_lock: str
    require_supply_chain_lock: bool
    effect_journal: str
    human_checkpoint_out: str
    human_checkpoint_store: str
    human_resume_checkpoint: str
    human_approval_host: str
    human_approval_authority_timeout_ms: int
    trace_pure_functions: Literal["full", "calls"]
    human_decisions: dict[str, Any]
    parallel_checkpoint_out: str
    parallel_resume_checkpoint: str
    parallel_limits: dict[str, Any]
    user_inputs: dict[str, Any]
    agent_decisions: dict[str, Any]
    agent_decision_provider: str
    agent_decision_provider_metadata: dict[str, Any]
    agent_decision_provider_initial_mode: Literal["summary", "capabilities"]
    agent_decision_provider_content_mode: Literal["inline", "opaque_refs"]
    agent_decision_provider_timeout_ms: int
    agent_decision_provider_max_retries: int
    skill_packs: list[str]
    active_skill_pack_refs: list[str]
    skill_pack_discovery_max_bytes: int
    skill_pack_activation_max_bytes: int
    agent_model_input_max_bytes: int
    max_agent_steps: int
    max_provider_calls: int
    run_limits: dict[str, Any]
    trigger_event: dict[str, Any]
    trigger_state: str
    trace_out: str
    trace_store: str
    trace_mode: Literal["inline", "reference"]
    cancel_before_dispatch: bool
    cancel_on_pause: bool
    timeout: float
    cancel_event: Event


PATHS = {
    "manifest": "manifest", "secrets": "secrets", "resource_bindings": "resource-bindings",
    "supply_chain_lock": "supply-chain-lock", "effect_journal": "effect-journal",
    "human_checkpoint_out": "human-checkpoint-out", "human_resume_checkpoint": "human-resume-checkpoint",
    "human_checkpoint_store": "human-checkpoint-store",
    "human_approval_host": "human-approval-host", "parallel_checkpoint_out": "parallel-checkpoint-out",
    "parallel_resume_checkpoint": "parallel-resume-checkpoint", "agent_decision_provider": "agent-decision-provider",
    "trigger_state": "state", "trace_out": "trace-out", "trace_store": "trace-store",
}
JSON_OPTIONS = {
    key: flag for key, flag in [
        ("inputs", "inputs"), ("human_decisions", "human-decisions"), ("user_inputs", "user-inputs"),
        ("agent_decisions", "agent-decisions"), ("parallel_limits", "parallel-limits"),
        ("run_limits", "run-limits"), ("trigger_event", "trigger-event"),
        ("agent_decision_provider_metadata", "agent-decision-provider-metadata"),
    ]
}
BOOL_OPTIONS = ("require_resource_bindings", "require_supply_chain_lock", "cancel_before_dispatch", "cancel_on_pause")
INT_OPTIONS = ("human_approval_authority_timeout_ms", "agent_decision_provider_timeout_ms", "agent_decision_provider_max_retries", "max_agent_steps",
               "max_provider_calls", "skill_pack_discovery_max_bytes", "skill_pack_activation_max_bytes", "agent_model_input_max_bytes")
MODES = {"trace_pure_functions": ("full", "calls"), "agent_decision_provider_initial_mode": ("summary", "capabilities"),
         "agent_decision_provider_content_mode": ("inline", "opaque_refs")}


def _text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ToubaEngineError("options", "InvalidTextOption")
    return value


def _json(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    except (TypeError, ValueError, OverflowError):
        raise ToubaEngineError("options", "InvalidJsonOption") from None


def _parse(raw: bytes, phase: str) -> Any:
    try:
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate JSON key")
                value[key] = item
            return value
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(ValueError("non-finite JSON")))
    except (ValueError, UnicodeError, RecursionError):
        raise ToubaEngineError(phase, "InvalidJsonResult") from None


def _result(raw: bytes, exit_code: int, trace_mode: str = "inline") -> RunResult:
    try:
        data = _parse(raw, "run")
    except ToubaEngineError:
        raise ToubaEngineError("run", "EngineCommandFailed" if exit_code else "InvalidJsonResult",
                              {"exit_code": exit_code, "stage": "result_transport"}) from None
    if (exit_code == 1 and isinstance(data, dict)
            and data == {"schema_version": "touba-command-error-v1", "code": "ExecutionInterrupted", "stage": "execution"}):
        raise ToubaEngineError("run", "ExecutionInterrupted", {"exit_code": exit_code, "stage": "execution"})
    if not isinstance(data, dict):
        raise ToubaEngineError("run", "InvalidRunResult")
    status, reason = data.get("status"), data.get("reason")
    trace, messages = data.get("trace"), data.get("messages")
    reference = None
    if data.get("schema_version") == "touba-run-reference-v1":
        if trace_mode != "reference":
            raise ToubaEngineError("run", "InvalidRunResult")
        try:
            reference = validate_reference(data.get("trace_reference"))
        except (ValueError, TypeError, UnicodeError, OverflowError):
            raise ToubaEngineError("run", "InvalidTraceReference") from None
    if not ((data.get("schema_version") == "touba-run-result-v1" and "trace_reference" not in data
              or reference is not None and "trace" not in data)
            and status in ("success", "stopped", "cancelled", "failure") and isinstance(reason, str)
            and isinstance(messages, list) and all(isinstance(m, dict) and isinstance(m.get("interaction_ref"), str)
                and isinstance(m.get("text"), str) for m in messages)
            and (reference is not None or isinstance(trace, dict) and isinstance(trace.get("events"), list) and trace["events"])):
        raise ToubaEngineError("run", "InvalidRunResult")
    last = {"kind": "run_completed", "payload": reference["terminal"]} if reference else trace["events"][-1]
    payload = last.get("payload", {}) if isinstance(last, dict) else {}
    if not isinstance(last, dict) or not isinstance(payload, dict):
        raise ToubaEngineError("run", "InvalidRunResult")
    admission = (reference is None and isinstance(trace.get("run"), dict) and trace["run"].get("admission") == "refused"
                 and len(trace["events"]) == 1 and last.get("kind") == "admission_refused"
                 and payload.get("code") == reason and status == "failure"
                 and data.get("result") is None and messages == [] and "pending_interaction" not in data
                 and "pending_interactions" not in data)
    terminal = isinstance(last, dict) and last.get("kind") == "run_completed" and payload.get("status") == status and payload.get("reason") == reason
    if trace_mode == "reference" and reference is None and not admission:
        raise ToubaEngineError("run", "InvalidRunResult")
    expected = (0 if status == "success" else 5 if status == "cancelled" or reason == "human_approval_cancelled"
                else (3 if reason in ("human_approval_pending", "user_input_pending") else 4) if status == "stopped" else 1)
    if not (admission or terminal) or (exit_code not in (1, 2) if admission else exit_code != expected):
        raise ToubaEngineError("run", "InvalidRunResult", {"exit_code": exit_code})
    if status == "failure":
        raise ToubaEngineError("run", reason, {"exit_code": exit_code, "status": status, "reason": reason, "trace": trace,
                                              **({"trace_reference": reference} if reference else {})})
    pending = data.get("pending_interaction")
    if pending is not None and (not isinstance(pending, dict) or set(pending) != {"interaction_ref", "prompt"}
            or not all(isinstance(value, str) for value in pending.values())
            or status != "stopped" or reason != "user_input_pending"):
        raise ToubaEngineError("run", "InvalidRunResult")
    pendings = data.get("pending_interactions", [pending] if pending else [])
    if not isinstance(pendings, list) or ("pending_interactions" in data and not pendings) or any(
            not isinstance(item, dict) or set(item) != {"interaction_ref", "prompt"}
            or not all(isinstance(value, str) for value in item.values()) for item in pendings):
        raise ToubaEngineError("run", "InvalidRunResult")
    if pendings and (status != "stopped" or reason not in ("user_input_pending", "human_approval_pending")
                     or len({item["interaction_ref"] for item in pendings}) != len(pendings)
                     or (pending is not None and pending != pendings[0])):
        raise ToubaEngineError("run", "InvalidRunResult")
    return RunResult(status, reason, data.get("result"), messages, trace, pending, pendings, reference)


def touba_sdk_metadata() -> dict[str, str]:
    digest = hashlib.sha256()
    root = Path(__file__).parent
    paths = []
    for directory, subdirs, files in os.walk(root, followlinks=False):
        subdirs[:] = [name for name in subdirs if name != "__pycache__"]
        for name in subdirs + files:
            if (Path(directory) / name).is_symlink():
                raise ToubaEngineError("identity", "HandlerSdkInvalid")
        paths.extend(Path(directory) / name for name in files if name.endswith(".py"))
    for path in sorted(paths, key=lambda file: file.relative_to(root).as_posix()):
        if not path.is_file() or path.stat().st_nlink != 1:
            raise ToubaEngineError("identity", "HandlerSdkInvalid")
        digest.update(path.relative_to(root).as_posix().encode()); digest.update(b"\0"); digest.update(path.read_bytes())
    return {"name": "touba-sdk", "version": VERSION, "build_sha256": digest.hexdigest(),
            "protocol": "touba-tool-handler-v1", "status": "ok"}


def _kill(child):
    try:
        if os.name == "posix":
            os.killpg(child.pid, signal.SIGKILL)
        elif child.returncode is None:
            child.kill()
    except ProcessLookupError:
        pass


class AsyncToubaEngine:
    def __init__(self, project_root: str | Path = ".", *, command: str = "touba",
                 command_args: Sequence[str] = (), env: Mapping[str, str] | None = None):
        self.project_root = Path(project_root).resolve()
        self.command = _text(command)
        if isinstance(command_args, str):
            raise ToubaEngineError("options", "InvalidCommandArguments")
        self.command_args = tuple(_text(arg) for arg in command_args)
        self.env = {**os.environ, **dict(env or {})}
        try:
            self.command, self.command_args, self.env = resolve_engine_command(
                self.command, self.command_args, self.project_root, self.env)
        except ValueError:
            raise ToubaEngineError("options", "EngineBatchLauncherUnsupported") from None

    def _path(self, value: str) -> str:
        path = Path(_text(value))
        return str(path if path.is_absolute() else self.project_root / path)

    async def _execute(self, phase: str, args: list[str], *, timeout: float | None = None,
                       cancel_event: Event | None = None) -> tuple[int, bytes]:
        if timeout is not None and (isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0):
            raise ToubaEngineError("options", "InvalidTimeout")
        if cancel_event is not None and not isinstance(cancel_event, Event):
            raise ToubaEngineError("options", "InvalidCancellationEvent")
        if cancel_event is not None and cancel_event.is_set():
            raise ToubaEngineError(phase, "EngineCancelled")
        launch = asyncio.create_task(asyncio.create_subprocess_exec(self.command, *self.command_args, *args,
                cwd=self.project_root, env=self.env, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, start_new_session=os.name == "posix"))
        try:
            child = await asyncio.shield(launch)
        except asyncio.CancelledError:
            # Cancellation can race with process creation. Reap the launch and
            # its dedicated group instead of losing the child handle.
            try:
                child = await launch
            except OSError:
                raise asyncio.CancelledError from None
            _kill(child)
            await child.communicate()
            raise
        except OSError as error:
            raise ToubaEngineError(phase, "LaunchFailed", {"errno": error.errno}) from None

        async def read(stream, retain):
            chunks, size = [], 0
            while chunk := await stream.read(65536):
                size += len(chunk)
                if size > MAX_OUTPUT:
                    raise ToubaEngineError(phase, "EngineOutputLimitExceeded")
                if retain:
                    chunks.append(chunk)
            return b"".join(chunks)

        async def cancelled():
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    raise ToubaEngineError(phase, "EngineCancelled")
                await asyncio.sleep(.02)

        readers = [asyncio.create_task(read(child.stdout, True)), asyncio.create_task(read(child.stderr, False)), asyncio.create_task(child.wait())]
        collection = asyncio.gather(*readers)
        monitor = asyncio.create_task(cancelled())
        try:
            done, _ = await asyncio.wait([collection, monitor], timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
            if not done:
                raise ToubaEngineError(phase, "EngineTimeout")
            if monitor in done:
                await monitor
            stdout, _, code = await collection
            return code, stdout
        finally:
            if child.returncode is None or any(not task.done() for task in readers):
                # A finished parent can leave descendants holding its pipes.
                _kill(child)
            # Process.wait() waits for exit, not for every pipe to disconnect.
            # Process has no public close method; close its owned asyncio
            # transport before the caller can dispose of the event loop.
            child._transport.close()
            await child.wait()
            monitor.cancel(); collection.cancel()
            for task in readers:
                task.cancel()
            await asyncio.gather(monitor, collection, *readers, return_exceptions=True)

    async def create_compensation(self, **options) -> dict[str, Any]:
        return await self._compensate("create", options)

    async def resume_compensation(self, **options) -> dict[str, Any]:
        return await self._compensate("resume", options)

    async def _compensate(self, operation: str, options: dict[str, Any]) -> dict[str, Any]:
        paths = {"air": "air", "manifest": "manifest", "effect_journal": "effect-journal", "store": "store",
                 "authority_host": "authority-host", "secrets": "secrets", "resource_bindings": "resource-bindings", "trace_store": "trace-store"}
        allowed = set(paths) | {"request", "run_limits", "authority_timeout_ms", "timeout", "cancel_event"}
        if options.keys() - allowed:
            raise ToubaEngineError("options", "UnknownCompensationOption")
        for key in ("air", "manifest", "effect_journal", "store", "authority_host"):
            _text(options.get(key))
        if not isinstance(options.get("request"), dict):
            raise ToubaEngineError("options", "JsonObjectRequired")
        args = ["compensation", operation, "--request-json", _json(options["request"])]
        for key, flag in paths.items():
            if key in options:
                args.extend(["--" + flag, self._path(options[key])])
        if "run_limits" in options:
            if not isinstance(options["run_limits"], dict):
                raise ToubaEngineError("options", "JsonObjectRequired")
            args.extend(["--run-limits-json", _json(options["run_limits"])])
        if "authority_timeout_ms" in options:
            value = options["authority_timeout_ms"]
            if type(value) is not int or value < 1 or value > 5000:
                raise ToubaEngineError("options", "InvalidAuthorityTimeout")
            args.extend(["--authority-timeout-ms", str(value)])
        code, raw = await self._execute("compensation", args, timeout=options.get("timeout"), cancel_event=options.get("cancel_event"))
        result = _parse(raw, "compensation")
        if code != 0:
            reason = result.get("code") if isinstance(result, dict) else None
            raise ToubaEngineError("compensation", reason if isinstance(reason, str) and reason.isascii() and reason.isalpha() and len(reason) <= 100 else "CompensationTransportInvalid")
        record = result.get("record") if isinstance(result, dict) else None
        if not isinstance(record, dict) or result.get("schema_version") != "touba-compensation-result-v1" or record.get("state") not in ("ready", "running", "action_required", "terminal") or type(record.get("revision")) is not int or record["revision"] < 1:
            raise ToubaEngineError("compensation", "CompensationTransportInvalid")
        return {"record": record}

    async def version(self) -> dict[str, Any]:
        code, raw = await self._execute("version", ["version", "--json"])
        if code != 0:
            raise ToubaEngineError("version", "VersionFailed")
        result = _parse(raw, "version")
        if not isinstance(result, dict) or not isinstance(result.get("cli"), str):
            raise ToubaEngineError("version", "InvalidVersionResult")
        return result

    async def compile(self, source: str, *, timeout: float | None = None, cancel_event: Event | None = None) -> CompileResult:
        code, raw = await self._execute("compile", ["compile", self._path(source), "--stdout"], timeout=timeout, cancel_event=cancel_event)
        if code != 0:
            raise ToubaEngineError("compile", "CompilationFailed", {"exit_code": code})
        document = _parse(raw, "compile")
        if not isinstance(document, dict) or document.get("air_schema_version") != "touba-air-v1":
            raise ToubaEngineError("compile", "InvalidAirResult")
        return CompileResult(raw.decode("utf-8"), document)

    async def run(self, **options: Unpack[RunOptions]) -> RunResult:
        unknown = options.keys() - RunOptions.__annotations__.keys()
        if unknown:
            raise ToubaEngineError("options", "UnknownRunOption")
        mode = options.get("trace_mode", "inline")
        if mode not in ("inline", "reference"):
            raise ToubaEngineError("options", "InvalidTraceMode")
        if sum(key in options for key in ("source", "air", "air_json", "project")) != 1:
            raise ToubaEngineError("options", "ExactlyOneProgramRequired")
        with tempfile.TemporaryDirectory(prefix="touba-python-engine-") as temporary:
            if "project" in options:
                air = None
            elif "air" in options:
                air = self._path(options["air"])
            else:
                document = options.get("air_json")
                if "source" in options:
                    compiled = await self.compile(options["source"], timeout=options.get("timeout"), cancel_event=options.get("cancel_event"))
                    document = compiled.air_json
                if isinstance(document, str):
                    document = _parse(document.encode("utf-8"), "options")
                if not isinstance(document, dict):
                    raise ToubaEngineError("options", "JsonObjectRequired")
                air = str(Path(temporary) / "program.air.json")
                Path(air).write_text(_json(document), encoding="utf-8")
                os.chmod(air, 0o600)
            selection = ["--project", self._path(_text(options["project"]))] if "project" in options else [air]
            args = ["run", *selection, "--output", "json-reference" if mode == "reference" else "json"]
            if "profile" in options:
                args.extend(["--profile", _text(options["profile"])])
            if "trace_store" not in options:
                args.extend(["--trace-store", self._path(".touba/traces.sqlite")])
            if "human_checkpoint_store" not in options:
                args.extend(["--human-checkpoint-store", self._path(".touba/approval-checkpoints.sqlite")])
            for key, flag in PATHS.items():
                if key in options:
                    selected = _text(options[key])
                    host = key in ("human_approval_host", "agent_decision_provider")
                    args.extend(["--" + flag, selected if host and selected.startswith("pkg:") else self._path(selected)])
            for key, flag in JSON_OPTIONS.items():
                if key in options:
                    if not isinstance(options[key], dict):
                        raise ToubaEngineError("options", "JsonObjectRequired")
                    args.extend(["--" + flag + "-json", _json(options[key])])
            for key in BOOL_OPTIONS:
                if key in options and type(options[key]) is not bool:
                    raise ToubaEngineError("options", "BooleanOptionRequired")
                if options.get(key) is True:
                    args.append("--" + key.replace("_", "-"))
            for key in INT_OPTIONS:
                if key in options:
                    minimum = 0 if key.endswith("max_retries") else 1
                    maximum = 60000 if key == "human_approval_authority_timeout_ms" else 9007199254740991
                    if type(options[key]) is not int or not minimum <= options[key] <= maximum:
                        raise ToubaEngineError("options", "IntegerOptionInvalid")
                    args.extend(["--" + key.replace("_", "-"), str(options[key])])
            for key, allowed in MODES.items():
                if key in options:
                    if options[key] not in allowed:
                        raise ToubaEngineError("options", "ProviderModeInvalid")
                    args.extend(["--" + key.replace("_", "-"), options[key]])
            if "entry_ref" in options:
                args.extend(["--entry", _text(options["entry_ref"])])
            for key, flag in (("skill_packs", "--skill-pack"), ("active_skill_pack_refs", "--activate-skill-pack")):
                if key in options:
                    if not isinstance(options[key], list):
                        raise ToubaEngineError("options", "ListOptionRequired")
                    for value in options[key]:
                        args.extend([flag, self._path(value) if key == "skill_packs" else _text(value)])
            code, raw = await self._execute("run", args, timeout=options.get("timeout"), cancel_event=options.get("cancel_event"))
            return _result(raw, code, mode)

    async def read_trace(self, *, trace_store: str, reference: dict[str, Any], after: int | None = None,
                         limit: int = 100, timeout: float | None = None, cancel_event: Event | None = None) -> dict[str, Any]:
        try:
            reference = json.loads(_json(validate_reference(reference)))
        except (ValueError, TypeError, UnicodeError, OverflowError):
            raise ToubaEngineError("trace", "InvalidTraceReference") from None
        after = reference["start_index"] - 1 if after is None else after
        if (type(after) is not int or not reference["start_index"] - 1 <= after < reference["start_index"] + reference["event_count"]
                or type(limit) is not int or not 1 <= limit <= 1000):
            raise ToubaEngineError("trace", "InvalidTracePage")
        args = ["trace", "read", "--store", self._path(trace_store), "--reference-json", _json(reference),
                "--after", str(after), "--limit", str(limit)]
        code, raw = await self._execute("trace", args, timeout=timeout, cancel_event=cancel_event)
        if code != 0:
            raise ToubaEngineError("trace", "TraceReadFailed", {"exit_code": code})
        try:
            return validate_page(_parse(raw, "trace"), reference, after, limit)
        except (ValueError, TypeError, UnicodeError, KeyError, AttributeError):
            raise ToubaEngineError("trace", "InvalidTracePage") from None


class ToubaEngine:
    """Synchronous facade. In an active asyncio loop, use AsyncToubaEngine instead."""
    def __init__(self, project_root: str | Path = ".", *, command: str = "touba",
                 command_args: Sequence[str] = (), env: Mapping[str, str] | None = None):
        self._async = AsyncToubaEngine(project_root, command=command, command_args=command_args, env=env)

    @staticmethod
    def _run(awaitable):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            running = False
        else:
            running = True
        if running:
            awaitable.close()
            raise ToubaEngineError("options", "UseAsyncToubaEngineInEventLoop")
        # Do not attach the expected absence of a running loop to Core errors.
        return asyncio.run(awaitable)

    def version(self) -> dict[str, Any]:
        return self._run(self._async.version())

    def compile(self, source: str, *, timeout: float | None = None, cancel_event: Event | None = None) -> CompileResult:
        return self._run(self._async.compile(source, timeout=timeout, cancel_event=cancel_event))

    def run(self, **options: Unpack[RunOptions]) -> RunResult:
        return self._run(self._async.run(**options))

    def create_compensation(self, **options) -> dict[str, Any]:
        return self._run(self._async.create_compensation(**options))

    def resume_compensation(self, **options) -> dict[str, Any]:
        return self._run(self._async.resume_compensation(**options))

    def read_trace(self, *, trace_store: str, reference: dict[str, Any], after: int | None = None,
                   limit: int = 100, timeout: float | None = None, cancel_event: Event | None = None) -> dict[str, Any]:
        return self._run(self._async.read_trace(trace_store=trace_store, reference=reference, after=after,
                                               limit=limit, timeout=timeout, cancel_event=cancel_event))
