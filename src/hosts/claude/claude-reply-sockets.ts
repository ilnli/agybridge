import { randomBytes } from 'node:crypto';
import { chmodSync, lstatSync, statSync, type BigIntStats } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { DeliveryError } from '../../shared/errors.js';

const CHECK_INTERVAL = 500;
const socketNode = (address: string) => lstatSync(address, { bigint: true, throwIfNoEntry: false });
const sameNode = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.isSocket();
const conflict = (address: string) => new DeliveryError('reply_socket_conflict', `Claude 回执套接字地址已被其他文件占用：${address}`);
const unavailable = (address: string) => new DeliveryError('reply_socket_unavailable', `Claude 回执套接字地址已消失：${address}`);
const closed = () => new DeliveryError('reply_socket_closed', 'Claude 回执监听已关闭。');

interface ReplyListener {
  address: string;
  published: boolean;
  server?: { listener: net.Server; node: BigIntStats };
  opening?: Promise<string>;
}

export class ClaudeReplySockets {
  private readonly listeners = new Map<string, ReplyListener>();
  private readonly connections = new Set<net.Socket>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;

  constructor(private readonly onReceipt: (receipt: unknown) => void) {}

  async address(directory: string): Promise<string> {
    if (this.stopped) throw closed();
    let entry = this.listeners.get(directory);
    if (!entry) {
      entry = { address: path.join(directory, `${process.pid}-${randomBytes(4).toString('hex')}.sock`), published: false };
      this.listeners.set(directory, entry);
    }
    try {
      const address = await this.ensure(entry);
      if (this.stopped) throw closed();
      return address;
    }
    catch (error) {
      if (!entry.published && this.listeners.get(directory) === entry) this.listeners.delete(directory);
      throw error;
    }
  }

  private async ensure(entry: ReplyListener): Promise<string> {
    if (entry.opening) return entry.opening;
    const node = socketNode(entry.address);
    if (node) {
      if (entry.server && sameNode(node, entry.server.node)) return entry.address;
      throw conflict(entry.address);
    }

                                         
    entry.server?.listener.close();
    entry.server = undefined;
    if (!statSync(path.dirname(entry.address), { throwIfNoEntry: false })?.isDirectory()) throw unavailable(entry.address);
    entry.opening = this.bind(entry);
    try { return await entry.opening; }
    finally { entry.opening = undefined; }
  }

  private async bind(entry: ReplyListener): Promise<string> {
    const server = net.createServer(socket => this.receive(socket));
    let node: BigIntStats | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.on('error', reject);
        server.listen({ path: entry.address, exclusive: true }, resolve);
                                                
        if (server.listening) {
          const bound = socketNode(entry.address);
          if (!bound) throw unavailable(entry.address);
          if (!bound.isSocket() || Number(bound.uid) !== process.getuid?.()) throw conflict(entry.address);
          node = bound;
          chmodSync(entry.address, 0o600);
        }
      });
      if (this.stopped) throw closed();
      const current = socketNode(entry.address);
      if (!current || !node) throw unavailable(entry.address);
      if (!sameNode(current, node)) throw conflict(entry.address);

      entry.server = { listener: server, node };
      entry.published = true;
                                               
      this.timer ??= setInterval(() => {
        for (const value of this.listeners.values()) if (value.published) void this.ensure(value).catch(() => {});
      }, CHECK_INTERVAL).unref();
      return entry.address;
    } catch (error) {
      this.closeListener(server, entry.address, node);
      throw error;
    }
  }

  private receive(socket: net.Socket): void {
    if (this.stopped) { socket.destroy(); return; }
    this.connections.add(socket);
    socket.once('close', () => this.connections.delete(socket));
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65536) { socket.destroy(); return; }
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        try {
          const receipt = JSON.parse(line);
          if (receipt.type === 'control' && receipt.action === 'peer_message_status') this.onReceipt(receipt);
        } catch {}
      }
    });
  }

  private closeListener(server: net.Server, address: string, bound?: BigIntStats): void {
    if (!server.listening) return;
    try {
      const current = socketNode(address);
      if (!current || (bound && sameNode(current, bound))) { server.close(); return; }
    } catch {}
                                              
    server.unref();
  }

  close(): void {
    this.stopped = true;
    clearInterval(this.timer);
    for (const { address, server } of this.listeners.values()) if (server) this.closeListener(server.listener, address, server.node);
    this.listeners.clear();
    for (const socket of this.connections) socket.destroy();
  }
}
