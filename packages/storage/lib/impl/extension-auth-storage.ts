import { createStorage, StorageEnum } from '../base/index.js';

/** Shape of the auth token storage */
interface AuthState {
  token: string | null;
}

const storage = createStorage<AuthState>(
  'litoral-auth-storage-key',
  {
    token: null,
  },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export const extensionAuthStorage = {
  ...storage,
  /** Set a new auth token */
  setToken: async (token: string) => {
    await storage.set({ token });
  },
  /** Get the current token (or null) */
  getToken: async (): Promise<string | null> => {
    const state = await storage.get();
    return state.token;
  },
  /** Clear the stored token */
  clearToken: async () => {
    await storage.set({ token: null });
  },
  /** Whether a token is currently stored */
  hasToken: async (): Promise<boolean> => {
    const state = await storage.get();
    return state.token !== null;
  },
};
