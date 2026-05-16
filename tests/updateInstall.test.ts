import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';
import {
  closeServerForUpdateInstall,
  trackServerConnections,
} from '../src/main/updateInstall.ts';

test('update install shutdown force-closes active media server connections', async () => {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/plain',
      Connection: 'keep-alive',
    });
    res.write('stream-open');
  });
  trackServerConnections(server, sockets);

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  assert.equal(typeof address, 'object');
  assert.ok(address);

  const socket = net.createConnection(address.port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: keep-alive\r\n\r\n');
  await once(socket, 'data');

  assert.equal(sockets.size, 1);
  await closeServerForUpdateInstall(server, sockets, 20);

  assert.equal(server.listening, false);
  assert.equal(sockets.size, 0);
});
