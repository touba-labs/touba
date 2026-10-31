import { TraceReader } from './reader.mjs';

let reader;
let queue = Promise.resolve();
const send = message => { if (process.connected) process.send(message, error => { if (error) process.exit(1); }); };
process.once('disconnect', () => { reader?.close(); process.exit(0); });
process.on('message', ({ initialize, id, method, args }) => {
  queue = queue.then(async () => {
    try {
      if (initialize) {
        if (reader) throw new Error('TraceRequestInvalid');
        try { reader = new TraceReader(initialize); send({ ready: true }); }
        catch (error) { send({ failed: true, error: error.message }); }
        return;
      }
      if (!reader || !['list', 'select', 'query', 'detail', 'graph', 'export', 'source', 'attachAir', 'close'].includes(method)) throw new Error('TraceRequestInvalid');
      const result = await reader[method](args);
      send({ id, result });
      if (method === 'close') process.disconnect();
    } catch (error) { send({ id, error: error.message }); }
  });
});
