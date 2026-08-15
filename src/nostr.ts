import { parseBunkerInput, BunkerSigner, createNostrConnectURI } from 'nostr-tools/nip46';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';

export interface NostrEvent {
  id?: string;
  pubkey?: string;
  sig?: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface NostrSigner {
  type: 'extension' | 'bunker' | 'readonly';
  getPublicKey(): Promise<string>;
  signEvent(unsignedEvent: any): Promise<NostrEvent>;
}

export class Nip07Signer implements NostrSigner {
  type: 'extension' = 'extension';

  async getPublicKey(): Promise<string> {
    if (!window.nostr) throw new Error("No NIP-07 extension found.");
    return await window.nostr.getPublicKey();
  }

  async signEvent(unsignedEvent: any): Promise<NostrEvent> {
    if (!window.nostr) throw new Error("No NIP-07 extension found.");
    return await window.nostr.signEvent(unsignedEvent);
  }
}

export class ReadOnlySigner implements NostrSigner {
  type: 'readonly' = 'readonly';
  private pubkey: string;

  constructor(pubkey: string) {
    this.pubkey = pubkey;
  }

  async getPublicKey(): Promise<string> {
    return this.pubkey;
  }

  async signEvent(_unsignedEvent: any): Promise<NostrEvent> {
    throw new Error("Cannot sign events in Read-Only mode.");
  }
}

export class BunkerNip46Signer implements NostrSigner {
  type: 'bunker' = 'bunker';
  private bunkerSigner: BunkerSigner;
  public clientSecretKeyHex: string;
  public bunkerUrl: string;
  public cachedPubkey?: string;

  constructor(bunkerSigner: BunkerSigner, clientSecretKeyHex: string, bunkerUrl: string, pubkey?: string) {
    this.bunkerSigner = bunkerSigner;
    this.clientSecretKeyHex = clientSecretKeyHex;
    this.bunkerUrl = bunkerUrl;
    this.cachedPubkey = pubkey;
  }

  async getPublicKey(): Promise<string> {
    if (this.cachedPubkey) return this.cachedPubkey;
    const pk = await this.bunkerSigner.getPublicKey();
    this.cachedPubkey = pk;
    return pk;
  }

  async signEvent(unsignedEvent: any): Promise<NostrEvent> {
    return await this.bunkerSigner.signEvent(unsignedEvent);
  }

  async close(): Promise<void> {
    try {
      await this.bunkerSigner.close();
    } catch (e) {}
  }
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function parseAnyBunkerInput(input: string): Promise<{ pubkey: string; relays: string[]; secret: string | null } | null> {
  const cleaned = input.trim().replace(/[\r\n\t\s]+/g, '');

  if (cleaned.startsWith('bunker://') || cleaned.startsWith('nostrconnect://')) {
    try {
      const url = new URL(cleaned);
      const pubkey = url.hostname.toLowerCase();
      if (/^[0-9a-f]{64}$/.test(pubkey)) {
        const relays = url.searchParams.getAll('relay');
        const secret = url.searchParams.get('secret');
        return { pubkey, relays, secret };
      }
    } catch (e) {}
  }

  try {
    return await parseBunkerInput(cleaned);
  } catch (e) {
    return null;
  }
}

export async function createBunkerSigner(
  bunkerUrlInput: string,
  existingClientSkHex?: string,
  onAuthCallback?: (authUrl: string) => void
): Promise<BunkerNip46Signer> {
  const cleanedUrl = bunkerUrlInput.trim().replace(/[\r\n\t\s]+/g, '');
  if (!cleanedUrl) {
    throw new Error("Bunker URL cannot be empty.");
  }

  let secretKeyBytes: Uint8Array;
  let secretKeyHex: string;

  if (existingClientSkHex && existingClientSkHex.length === 64) {
    secretKeyHex = existingClientSkHex;
    secretKeyBytes = hexToBytes(existingClientSkHex);
  } else {
    secretKeyBytes = generateSecretKey();
    secretKeyHex = bytesToHex(secretKeyBytes);
  }

  const bunkerParams: any = {
    onauth: (authUrl: string) => {
      console.log("NIP-46 Auth Challenge received:", authUrl);
      if (onAuthCallback) {
        onAuthCallback(authUrl);
      } else if (typeof window !== 'undefined') {
        if (authUrl.startsWith('http://') || authUrl.startsWith('https://')) {
          window.open(authUrl, '_blank', 'width=600,height=700');
        }
      }
    }
  };

  const bunkerPointer = await parseAnyBunkerInput(cleanedUrl);
  if (!bunkerPointer || !bunkerPointer.pubkey) {
    throw new Error("Invalid bunker:// or nostrconnect:// URL or NIP-05 format.");
  }
  if (!bunkerPointer.relays || bunkerPointer.relays.length === 0) {
    throw new Error("No relays specified in bunker URL. Please include at least one ?relay=wss://...");
  }

  const bunkerSigner = BunkerSigner.fromBunker(secretKeyBytes, bunkerPointer, bunkerParams);

  const appOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://watchlistr.app';
  const clientMetadata = { name: 'Watchlistr', url: appOrigin };

  // Send connect request with strict 10s timeout
  try {
    const connectPromise = bunkerSigner.connect(clientMetadata);
    await Promise.race([
      connectPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Connect request timed out after 10s. Please check if your remote signer app (e.g. Amber) is open.")), 10000)
      )
    ]);
  } catch (e: any) {
    const errStr = typeof e === 'string' ? e : (e?.message || JSON.stringify(e));
    console.warn("bunkerSigner.connect warning/error:", errStr);
    if (errStr.includes("no permission")) {
      throw new Error("Amber returned 'no permission'. Please open the Amber app on your Android phone, check for a connection prompt or App Permissions list, and tap 'Allow' for Watchlistr.");
    }
  }

  // Retrieve public key with strict 10s timeout
  let pubkey = '';
  try {
    const getPkPromise = bunkerSigner.getPublicKey();
    pubkey = await Promise.race([
      getPkPromise,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("Timed out waiting for public key from Remote Signer (10s).")), 10000)
      )
    ]);
  } catch (err: any) {
    const errStr = typeof err === 'string' ? err : (err?.message || JSON.stringify(err));
    if (errStr.includes("no permission")) {
      throw new Error("Amber returned 'no permission' for get_public_key. Please open Amber on your phone and grant permission for Watchlistr.");
    }
    throw err;
  }

  if (!pubkey) {
    throw new Error("Failed to retrieve public key from Remote Signer.");
  }

  return new BunkerNip46Signer(bunkerSigner, secretKeyHex, cleanedUrl, pubkey);
}

export interface NostrConnectSession {
  uri: string;
  clientSecretKeyHex: string;
  listen: () => Promise<BunkerNip46Signer>;
}

export function startNostrConnectSession(
  relays: string[] = ['wss://relay.damus.io', 'wss://nos.lol'],
  onAuthCallback?: (authUrl: string) => void
): NostrConnectSession {
  const clientSecretKey = generateSecretKey();
  const clientSecretKeyHex = bytesToHex(clientSecretKey);
  const clientPubkey = getPublicKey(clientSecretKey);
  const secretBytes = generateSecretKey().subarray(0, 16);
  const secretHex = bytesToHex(secretBytes);

  const appOrigin = typeof window !== 'undefined' ? window.location.origin : 'https://watchlistr.app';

  const uri = createNostrConnectURI({
    clientPubkey,
    relays,
    secret: secretHex,
    name: 'Watchlistr',
    url: appOrigin
  });

  const bunkerParams: any = {
    onauth: (authUrl: string) => {
      console.log("NIP-46 Auth Challenge received:", authUrl);
      if (onAuthCallback) {
        onAuthCallback(authUrl);
      } else if (typeof window !== 'undefined') {
        if (authUrl.startsWith('http://') || authUrl.startsWith('https://')) {
          window.open(authUrl, '_blank', 'width=600,height=700');
        }
      }
    }
  };

  const listen = async (): Promise<BunkerNip46Signer> => {
    let timeoutId: any;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error("Nostr Connect session timed out after 2 minutes. Please try again."));
      }, 120000);
    });

    try {
      const bunkerSigner = await Promise.race([
        BunkerSigner.fromURI(clientSecretKey, uri, bunkerParams, 120000),
        timeoutPromise
      ]);
      clearTimeout(timeoutId);

      const pubkey = await Promise.race([
        bunkerSigner.getPublicKey(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("Timed out fetching public key from remote signer (10s).")), 10000)
        )
      ]);

      const bunkerUrl = `bunker://${bunkerSigner.bp.pubkey}?${bunkerSigner.bp.relays.map(r => `relay=${encodeURIComponent(r)}`).join('&')}&secret=${bunkerSigner.bp.secret || ''}`;

      return new BunkerNip46Signer(bunkerSigner, clientSecretKeyHex, bunkerUrl, pubkey);
    } catch (err) {
      clearTimeout(timeoutId);
      throw err;
    }
  };

  return { uri, clientSecretKeyHex, listen };
}

export class NostrService {
  private relays: Map<string, WebSocket> = new Map();
  private relayStatuses: Record<string, boolean> = {};
  private onStatusChangeCallback?: (status: Record<string, boolean>) => void;

  constructor(defaultRelays: string[], onStatusChange?: (status: Record<string, boolean>) => void) {
    this.onStatusChangeCallback = onStatusChange;
    defaultRelays.forEach(url => this.connectRelay(url));
  }

  // Update status callback
  public setStatusCallback(callback: (status: Record<string, boolean>) => void) {
    this.onStatusChangeCallback = callback;
    callback({ ...this.relayStatuses });
  }

  public connectRelays(callback?: (statuses: Record<string, boolean>) => void) {
    if (callback) {
      this.setStatusCallback(callback);
    }
  }

  public close() {
    Array.from(this.relays.keys()).forEach(url => this.disconnectRelay(url));
  }

  // Connect to a single Nostr relay
  public connectRelay(url: string) {
    if (this.relays.has(url)) return;

    try {
      const ws = new WebSocket(url);
      this.relays.set(url, ws);
      this.relayStatuses[url] = false;
      this.triggerStatusChange();

      ws.onopen = () => {
        this.relayStatuses[url] = true;
        this.triggerStatusChange();
        console.log(`Connected to Nostr relay: ${url}`);
      };

      ws.onclose = () => {
        this.relayStatuses[url] = false;
        this.triggerStatusChange();
        console.log(`Disconnected from Nostr relay: ${url}`);
        // Attempt reconnect after 5 seconds
        setTimeout(() => {
          this.relays.delete(url);
          this.connectRelay(url);
        }, 5000);
      };

      ws.onerror = (err) => {
        console.error(`Relay connection error on ${url}:`, err);
        this.relayStatuses[url] = false;
        this.triggerStatusChange();
      };
    } catch (e) {
      console.error(`Failed to initialize WebSocket for ${url}:`, e);
    }
  }

  // Disconnect from a relay and clean up
  public disconnectRelay(url: string) {
    const ws = this.relays.get(url);
    if (ws) {
      ws.close();
      this.relays.delete(url);
      delete this.relayStatuses[url];
      this.triggerStatusChange();
    }
  }

  public getConnectedRelays(): string[] {
    return Array.from(this.relays.keys());
  }

  public getRelayStatuses(): Record<string, boolean> {
    return { ...this.relayStatuses };
  }

  private triggerStatusChange() {
    if (this.onStatusChangeCallback) {
      this.onStatusChangeCallback({ ...this.relayStatuses });
    }
  }

  // Fetch all kind:30016 events for a pubkey
  public async fetchUserLists(pubkey: string, timeoutMs: number = 4000): Promise<NostrEvent[]> {
    const eventsMap: Map<string, NostrEvent> = new Map(); // d-tag -> Event
    const promises: Promise<void>[] = [];

    // Wait up to 3 seconds for sockets to connect if none are open yet
    let activeWebSockets = Array.from(this.relays.entries()).filter(
      ([_, ws]) => ws.readyState === WebSocket.OPEN
    );

    if (activeWebSockets.length === 0) {
      await new Promise<void>((resolve) => {
        let checkCount = 0;
        const interval = setInterval(() => {
          checkCount++;
          const openSockets = Array.from(this.relays.entries()).filter(
            ([_, ws]) => ws.readyState === WebSocket.OPEN
          );
          if (openSockets.length > 0 || checkCount >= 15) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      });

      activeWebSockets = Array.from(this.relays.entries()).filter(
        ([_, ws]) => ws.readyState === WebSocket.OPEN
      );
    }

    if (activeWebSockets.length === 0) {
      console.warn("No active relay connections to fetch lists.");
      return [];
    }

    const subId = `sub_lists_${Math.random().toString(36).substring(2, 9)}`;
    const filter = {
      authors: [pubkey],
      kinds: [30016]
    };

    activeWebSockets.forEach(([url, ws]) => {
      const promise = new Promise<void>((resolve) => {
        const handleMessage = (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            if (data[0] === 'EVENT' && data[1] === subId) {
              const event = data[2] as NostrEvent;
              const dTag = event.tags.find(t => t[0] === 'd')?.[1];
              if (dTag) {
                const existing = eventsMap.get(dTag);
                // Keep the newer event (replaceable event rule)
                if (!existing || event.created_at > existing.created_at) {
                  eventsMap.set(dTag, event);
                }
              }
            } else if (data[0] === 'EOSE' && data[1] === subId) {
              cleanup();
              resolve();
            }
          } catch (err) {
            console.error(`Error parsing message from relay ${url}:`, err);
          }
        };

        const cleanup = () => {
          ws.removeEventListener('message', handleMessage);
        };

        // Listen for events
        ws.addEventListener('message', handleMessage);

        // Send request
        ws.send(JSON.stringify(['REQ', subId, filter]));

        // Resolve on timeout as a fallback
        setTimeout(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(['CLOSE', subId]));
            }
          } catch (e) { }
          cleanup();
          resolve();
        }, timeoutMs);
      });

      promises.push(promise);
    });

    // Wait for all relays to finish EOSE or timeout
    await Promise.all(promises);
    return Array.from(eventsMap.values());
  }

  // Fetch kind:0 metadata profile for a pubkey
  public async fetchUserProfile(pubkey: string, timeoutMs: number = 3000): Promise<NostrEvent | null> {
    let newestEvent: NostrEvent | null = null;
    const promises: Promise<void>[] = [];

    // Wait up to 3 seconds for sockets to connect if none are open yet
    let activeWebSockets = Array.from(this.relays.entries()).filter(
      ([_, ws]) => ws.readyState === WebSocket.OPEN
    );

    if (activeWebSockets.length === 0) {
      await new Promise<void>((resolve) => {
        let checkCount = 0;
        const interval = setInterval(() => {
          checkCount++;
          const openSockets = Array.from(this.relays.entries()).filter(
            ([_, ws]) => ws.readyState === WebSocket.OPEN
          );
          if (openSockets.length > 0 || checkCount >= 15) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      });

      activeWebSockets = Array.from(this.relays.entries()).filter(
        ([_, ws]) => ws.readyState === WebSocket.OPEN
      );
    }

    if (activeWebSockets.length === 0) {
      return null;
    }

    const subId = `sub_profile_${Math.random().toString(36).substring(2, 9)}`;
    const filter = {
      authors: [pubkey],
      kinds: [0],
      limit: 1
    };

    activeWebSockets.forEach(([url, ws]) => {
      const promise = new Promise<void>((resolve) => {
        const handleMessage = (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            if (data[0] === 'EVENT' && data[1] === subId) {
              const event = data[2] as NostrEvent;
              if (!newestEvent || event.created_at > newestEvent.created_at) {
                newestEvent = event;
              }
            } else if (data[0] === 'EOSE' && data[1] === subId) {
              cleanup();
              resolve();
            }
          } catch (err) {
            console.error(`Error parsing profile from relay ${url}:`, err);
          }
        };

        const cleanup = () => {
          ws.removeEventListener('message', handleMessage);
        };

        ws.addEventListener('message', handleMessage);
        ws.send(JSON.stringify(['REQ', subId, filter]));

        setTimeout(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(['CLOSE', subId]));
            }
          } catch (e) { }
          cleanup();
          resolve();
        }, timeoutMs);
      });

      promises.push(promise);
    });

    await Promise.all(promises);
    return newestEvent;
  }

  // Fetch kind:10016 follow list for a pubkey
  public async fetchUserFollows(pubkey: string, timeoutMs: number = 3000): Promise<string[]> {
    let newestEvent: NostrEvent | null = null;
    const promises: Promise<void>[] = [];

    let activeWebSockets = Array.from(this.relays.entries()).filter(
      ([_, ws]) => ws.readyState === WebSocket.OPEN
    );

    if (activeWebSockets.length === 0) {
      await new Promise<void>((resolve) => {
        let checkCount = 0;
        const interval = setInterval(() => {
          checkCount++;
          const openSockets = Array.from(this.relays.entries()).filter(
            ([_, ws]) => ws.readyState === WebSocket.OPEN
          );
          if (openSockets.length > 0 || checkCount >= 15) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      });

      activeWebSockets = Array.from(this.relays.entries()).filter(
        ([_, ws]) => ws.readyState === WebSocket.OPEN
      );
    }

    if (activeWebSockets.length === 0) {
      return [];
    }

    const subId = `sub_follows_${Math.random().toString(36).substring(2, 9)}`;
    const filter = {
      authors: [pubkey],
      kinds: [10016],
      limit: 1
    };

    activeWebSockets.forEach(([url, ws]) => {
      const promise = new Promise<void>((resolve) => {
        const handleMessage = (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            if (data[0] === 'EVENT' && data[1] === subId) {
              const event = data[2] as NostrEvent;
              if (!newestEvent || event.created_at > newestEvent.created_at) {
                newestEvent = event;
              }
            } else if (data[0] === 'EOSE' && data[1] === subId) {
              cleanup();
              resolve();
            }
          } catch (err) {
            console.error(`Error parsing follows from relay ${url}:`, err);
          }
        };

        const cleanup = () => {
          ws.removeEventListener('message', handleMessage);
        };

        ws.addEventListener('message', handleMessage);
        ws.send(JSON.stringify(['REQ', subId, filter]));

        setTimeout(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(['CLOSE', subId]));
            }
          } catch (e) {}
          cleanup();
          resolve();
        }, timeoutMs);
      });

      promises.push(promise);
    });

    await Promise.all(promises);

    if (!newestEvent) return [];
    return (newestEvent as NostrEvent).tags
      .filter(t => t[0] === 'p' && t[1])
      .map(t => t[1]);
  }

  // Fetch kind:30016 lists for multiple followed pubkeys
  public async fetchFollowedLists(pubkeys: string[], timeoutMs: number = 4000): Promise<NostrEvent[]> {
    if (pubkeys.length === 0) return [];

    const eventsMap: Map<string, NostrEvent> = new Map(); // pubkey:d-tag -> Event
    const promises: Promise<void>[] = [];

    let activeWebSockets = Array.from(this.relays.entries()).filter(
      ([_, ws]) => ws.readyState === WebSocket.OPEN
    );

    if (activeWebSockets.length === 0) {
      await new Promise<void>((resolve) => {
        let checkCount = 0;
        const interval = setInterval(() => {
          checkCount++;
          const openSockets = Array.from(this.relays.entries()).filter(
            ([_, ws]) => ws.readyState === WebSocket.OPEN
          );
          if (openSockets.length > 0 || checkCount >= 15) {
            clearInterval(interval);
            resolve();
          }
        }, 200);
      });

      activeWebSockets = Array.from(this.relays.entries()).filter(
        ([_, ws]) => ws.readyState === WebSocket.OPEN
      );
    }

    if (activeWebSockets.length === 0) {
      return [];
    }

    const subId = `sub_ffollowed_${Math.random().toString(36).substring(2, 9)}`;
    const filter = {
      authors: pubkeys,
      kinds: [30016]
    };

    activeWebSockets.forEach(([url, ws]) => {
      const promise = new Promise<void>((resolve) => {
        const handleMessage = (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data);
            if (data[0] === 'EVENT' && data[1] === subId) {
              const event = data[2] as NostrEvent;
              const dTag = event.tags.find(t => t[0] === 'd')?.[1] || '';
              const key = `${event.pubkey}:${dTag}`;
              const existing = eventsMap.get(key);
              if (!existing || event.created_at > existing.created_at) {
                eventsMap.set(key, event);
              }
            } else if (data[0] === 'EOSE' && data[1] === subId) {
              cleanup();
              resolve();
            }
          } catch (err) {
            console.error(`Error parsing followed lists from relay ${url}:`, err);
          }
        };

        const cleanup = () => {
          ws.removeEventListener('message', handleMessage);
        };

        ws.addEventListener('message', handleMessage);
        ws.send(JSON.stringify(['REQ', subId, filter]));

        setTimeout(() => {
          try {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(['CLOSE', subId]));
            }
          } catch (e) {}
          cleanup();
          resolve();
        }, timeoutMs);
      });

      promises.push(promise);
    });

    await Promise.all(promises);
    return Array.from(eventsMap.values());
  }

  // Publish a signed event to all active relays
  public async publishEvent(event: NostrEvent): Promise<boolean> {
    const activeWebSockets = Array.from(this.relays.values()).filter(
      ws => ws.readyState === WebSocket.OPEN
    );

    if (activeWebSockets.length === 0) {
      console.error("Cannot publish: no active relay connections.");
      return false;
    }

    const payload = JSON.stringify(['EVENT', event]);
    let successCount = 0;

    activeWebSockets.forEach(ws => {
      try {
        ws.send(payload);
        successCount++;
      } catch (err) {
        console.error("Failed to send event to relay WebSocket:", err);
      }
    });

    return successCount > 0;
  }
}
