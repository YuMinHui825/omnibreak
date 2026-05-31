import * as vscode from 'vscode';
import type { DeviceConfig } from '../shared/types';
import { STORAGE_KEY_DEVICES, STORAGE_PREFIX_SSH_PW, STORAGE_PREFIX_SUDO_PW } from '../shared/constants';

export class DeviceManager {
  private secrets: vscode.SecretStorage;
  private devices: DeviceConfig[] = [];
  private listeners = new Set<() => void>();

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
  }

  async load(): Promise<DeviceConfig[]> {
    try {
      const raw = await this.secrets.get(STORAGE_KEY_DEVICES);
      this.devices = raw ? JSON.parse(raw) : [];
    } catch {
      this.devices = [];
    }
    return this.devices;
  }

  getAll(): DeviceConfig[] {
    return this.devices;
  }

  get(id: string): DeviceConfig | undefined {
    return this.devices.find((d) => d.id === id);
  }

  async save(device: DeviceConfig): Promise<DeviceConfig> {
    const idx = this.devices.findIndex((d) => d.id === device.id);
    if (idx >= 0) {
      this.devices[idx] = { ...device, updatedAt: Date.now() };
    } else {
      this.devices.push({ ...device, id: generateId(), createdAt: Date.now(), updatedAt: Date.now() });
    }
    await this.persist();
    this.emit();
    return this.devices.find(d => d.id === device.id) || this.devices[this.devices.length-1];
  }

  async remove(id: string): Promise<void> {
    this.devices = this.devices.filter((d) => d.id !== id);
    await this.secrets.delete(`${STORAGE_PREFIX_SSH_PW}${id}`);
    await this.secrets.delete(`${STORAGE_PREFIX_SUDO_PW}${id}`);
    await this.persist();
    this.emit();
  }

  async setSshPassword(deviceId: string, password: string): Promise<void> {
    await this.secrets.store(`${STORAGE_PREFIX_SSH_PW}${deviceId}`, password);
  }

  async getSshPassword(deviceId: string): Promise<string | undefined> {
    return this.secrets.get(`${STORAGE_PREFIX_SSH_PW}${deviceId}`);
  }

  async setSudoPassword(deviceId: string, password: string): Promise<void> {
    await this.secrets.store(`${STORAGE_PREFIX_SUDO_PW}${deviceId}`, password);
  }

  async getSudoPassword(deviceId: string): Promise<string | undefined> {
    return this.secrets.get(`${STORAGE_PREFIX_SUDO_PW}${deviceId}`);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private async persist() {
    await this.secrets.store(STORAGE_KEY_DEVICES, JSON.stringify(this.devices));
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }
}

function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
