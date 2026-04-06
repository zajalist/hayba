import { describe, it, expect } from 'vitest';
import { UETcpClient } from './tcp-client.js';

describe('UETcpClient', () => {
  it('should create a client with default host/port', () => {
    const client = new UETcpClient();
    expect(client.isConnected()).toBe(false);
  });

  it('should create a client with custom host/port', () => {
    const client = new UETcpClient('localhost', 9999);
    expect(client.isConnected()).toBe(false);
  });

  it('should reject send when not connected', async () => {
    const client = new UETcpClient();
    await expect(client.send('ping')).rejects.toThrow('Not connected');
  });
});
