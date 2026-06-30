/**
 * OpenClaw instances + models web API (LSM Phase G · Req 24.3 — model picker).
 *
 * Mirrors the mobile/desktop model-selection contract so the web chat reads &
 * writes the SAME server-side per-instance activeModel: model choice syncs
 * across web / mobile / desktop when they point at the same instance.
 *  - GET  /openclaw/instances                 → user's instances (find primary)
 *  - GET  /openclaw/models                     → available models (platform + BYO)
 *  - PATCH /openclaw/instances/:id/model       → switch the instance's activeModel
 */
import { apiClient } from './client';

export interface OpenClawInstanceInfo {
  id: string;
  name?: string;
  isPrimary?: boolean;
  status?: string;
  capabilities?: { activeModel?: string; platformHosted?: boolean; [k: string]: any };
  [k: string]: any;
}

export interface AvailableModel {
  id: string;
  label: string;
  provider: string;
  icon?: string;
  badge?: string;
  availability?: 'available' | 'coming_soon' | 'requires_key';
  costTier?: string;
}

export const openclawApi = {
  async getMyInstances(): Promise<OpenClawInstanceInfo[]> {
    return (await apiClient.get<OpenClawInstanceInfo[]>('/openclaw/instances')) || [];
  },

  /** Resolve the user's primary (or first) usable instance, or null. */
  async getPrimaryInstance(): Promise<OpenClawInstanceInfo | null> {
    const list = await this.getMyInstances();
    if (!list.length) return null;
    return list.find((i) => i.isPrimary) || list[0];
  },

  async getAvailableModels(): Promise<AvailableModel[]> {
    return (await apiClient.get<AvailableModel[]>('/openclaw/models')) || [];
  },

  async switchInstanceModel(
    instanceId: string,
    modelId: string,
  ): Promise<{ success: boolean; modelId: string } | null> {
    return apiClient.patch(`/openclaw/instances/${instanceId}/model`, { modelId });
  },
};
