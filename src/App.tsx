import React, { useState, useEffect, useRef } from 'react';
import {
  Search,
  X,
  Plus,
  Check,
  Trash2,
  Film,
  Tv,
  Pencil,
  ExternalLink,
  ArrowLeft,
  RefreshCw,
  Bookmark,
  Users,
  User,
  UserPlus,
  UserMinus,
  Globe,
  Smartphone,
  Key,
  Copy
} from 'lucide-react';
import {
  NostrService,
  Nip07Signer,
  ReadOnlySigner,
  BunkerNip46Signer,
  createBunkerSigner,
  startNostrConnectSession
} from './nostr';
import type { NostrSigner } from './nostr';
import './App.css';

declare global {
  interface Window {
    nostr?: any;
  }
}

// TypeScript interfaces
interface Media {
  id: string;
  title: string;
  year: string;
  type: 'movie' | 'tv';
  poster: string;
  genres: string[];
  watchedDate?: string;
  userRating?: number;
  slug?: string;
  director?: string;
  creator?: string;
  overview?: string;
}

interface MediaList {
  id: string;
  title: string;
  description: string;
  type: 'watchlist' | 'watched';
  items: Media[];
  createdAt: number;
}

interface NostrUser {
  pubkey: string;
  npub?: string;
  name?: string;
  picture?: string;
  readOnly?: boolean;
  signerType: 'extension' | 'bunker' | 'readonly';
  bunkerUrl?: string;
  bunkerClientSk?: string;
}

// Render director or creator info cleanly below title
const renderDirectorCreator = (item: Media) => {
  if (item.type === 'movie' && item.director) {
    return <div className="media-creator-director">{item.director}</div>;
  }
  if (item.type === 'tv' && item.creator) {
    return <div className="media-creator-director">{item.creator}</div>;
  }
  return null;
};

const cleanListTitle = (title: string): string => {
  return title ? title.replace(/\s*\(Default\)$/i, '').trim() : '';
};

const isDefaultList = (list: { id: string }): boolean => {
  return list.id === 'watchlist:default' || list.id === 'watched:default' || list.id.endsWith(':default');
};

const renderListTitle = (list: { id: string; title: string }) => {
  const clean = cleanListTitle(list.title);
  if (isDefaultList(list)) {
    return (
      <>
        {clean} <span style={{ fontWeight: 400, opacity: 0.8 }}>(Default)</span>
      </>
    );
  }
  return clean;
};


function App() {
  // Lists states with LocalStorage persistence
  const [lists, setLists] = useState<MediaList[]>(() => {
    const savedLists = localStorage.getItem('watchlistr_lists');
    if (savedLists) {
      try {
        const parsed: MediaList[] = JSON.parse(savedLists);
        return parsed.map(l => ({
          ...l,
          title: cleanListTitle(l.title)
        }));
      } catch (e) {}
    }

    const savedWatchlist = localStorage.getItem('watchlistr_watchlist');
    const savedWatched = localStorage.getItem('watchlistr_watched');
    const initialWatchlistItems: Media[] = savedWatchlist ? JSON.parse(savedWatchlist) : [];
    const initialWatchedItems: Media[] = savedWatched ? JSON.parse(savedWatched) : [];

    return [
      {
        id: 'watchlist:default',
        title: 'To Watch',
        description: 'My default list of items to watch.',
        type: 'watchlist',
        items: initialWatchlistItems,
        createdAt: initialWatchlistItems.length > 0 ? Math.floor(Date.now() / 1000) : 0
      },
      {
        id: 'watched:default',
        title: 'Watched',
        description: 'My default list of watched items.',
        type: 'watched',
        items: initialWatchedItems,
        createdAt: initialWatchedItems.length > 0 ? Math.floor(Date.now() / 1000) : 0
      }
    ];
  });

  const [activeWatchlistId, setActiveWatchlistId] = useState<string>('watchlist:default');
  const [activeWatchedId, setActiveWatchedId] = useState<string>('watched:default');

  // Page Navigation State: null = Page 1 (List Hub & Auth), string = Page 2 (Single List Workspace)
  const [selectedListId, setSelectedListId] = useState<string | null>(null);

  // Save lists to LocalStorage whenever modified
  useEffect(() => {
    localStorage.setItem('watchlistr_lists', JSON.stringify(lists));
  }, [lists]);

  // Nostr User & Signer states
  const [nostrUser, setNostrUser] = useState<NostrUser | null>(() => {
    const savedUser = localStorage.getItem('watchlistr_nostr_user');
    return savedUser ? JSON.parse(savedUser) : null;
  });

  const activeSignerRef = useRef<NostrSigner | null>(null);
  const [hasNostrExtension, setHasNostrExtension] = useState<boolean>(false);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [relayStatuses, setRelayStatuses] = useState<Record<string, boolean>>({});
  const nostrServiceRef = useRef<NostrService | null>(null);

  // Auth Card Multi-Tab state
  const [activeAuthTab, setActiveAuthTab] = useState<'bunker' | 'extension' | 'readonly'>('bunker');
  const [bunkerSubMode, setBunkerSubMode] = useState<'nostrconnect' | 'manual'>('nostrconnect');
  const [bunkerInputUrl, setBunkerInputUrl] = useState('');
  const [bunkerConnecting, setBunkerConnecting] = useState(false);
  const [bunkerError, setBunkerError] = useState<string | null>(null);
  const [authChallengeUrl, setAuthChallengeUrl] = useState<string | null>(null);
  const [readOnlyInputKey, setReadOnlyInputKey] = useState('');
  const [nostrConnectUri, setNostrConnectUri] = useState<string | null>(null);
  const [isNostrConnectListening, setIsNostrConnectListening] = useState<boolean>(false);
  const [copiedLink, setCopiedLink] = useState<boolean>(false);

  const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://relay.snort.social'
  ];

  const activeWatched = lists.find(x => x.id === activeWatchedId) || { items: [] };
  const watchedList = activeWatched.items;

  // Social & Follows & Explore state
  const [activeHubTab, setActiveHubTab] = useState<'my-lists' | 'explore' | 'following'>('my-lists');
  const [followedPubkeys, setFollowedPubkeys] = useState<string[]>(() => {
    const saved = localStorage.getItem('watchlistr_followed_pubkeys');
    return saved ? JSON.parse(saved) : [];
  });
  const [followedProfiles, setFollowedProfiles] = useState<Record<string, { name?: string; picture?: string }>>({});
  const [followedListsMap, setFollowedListsMap] = useState<Record<string, MediaList[]>>({});

  // Explore tab state
  const [exploreLists, setExploreLists] = useState<MediaList[]>([]);
  const [exploreProfiles, setExploreProfiles] = useState<Record<string, { name?: string; picture?: string }>>({});
  const [isExploreLoading, setIsExploreLoading] = useState(false);
  const [isExploreLoadingMore, setIsExploreLoadingMore] = useState(false);
  const [hasMoreExplore, setHasMoreExplore] = useState(true);
  const [exploreUntil, setExploreUntil] = useState<number | undefined>(undefined);
  const exploreObserverRef = useRef<HTMLDivElement | null>(null);
  const [isFollowModalOpen, setIsFollowModalOpen] = useState(false);
  const [followInputKey, setFollowInputKey] = useState('');
  const [followError, setFollowError] = useState<string | null>(null);

  // Author profile summary modal state
  const [authorProfileModal, setAuthorProfileModal] = useState<{
    isOpen: boolean;
    pubkey: string | null;
  }>({ isOpen: false, pubkey: null });

  // Following tab collapse/expand state
  const [expandedFollowingUsers, setExpandedFollowingUsers] = useState<Record<string, boolean>>({});

  const toggleFollowedUserExpand = (pk: string) => {
    setExpandedFollowingUsers(prev => ({
      ...prev,
      [pk]: !prev[pk]
    }));
  };

  // Search input state
  const [searchQuery, setSearchQuery] = useState('');

  // API search states
  const [searchResults, setSearchResults] = useState<Media[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modal state for logging watched details
  const [logModal, setLogModal] = useState<{
    isOpen: boolean;
    item: Media | null;
    year: string;
    month: string;
    day: string;
    rating: string;
    sourceList: 'search' | 'watchlist' | 'edit';
    targetListId: string;
  }>({
    isOpen: false,
    item: null,
    year: '',
    month: '',
    day: '',
    rating: '8',
    sourceList: 'search',
    targetListId: 'watched:default'
  });

  // Modal state for viewing TVDB details
  const [detailsModal, setDetailsModal] = useState<{
    isOpen: boolean;
    item: Media | null;
    isLoading: boolean;
    error: string | null;
    extendedInfo: any | null;
  }>({
    isOpen: false,
    item: null,
    isLoading: false,
    error: null,
    extendedInfo: null
  });

  // Drawer state for search overlay on Page 2
  const [isSearchDrawerOpen, setIsSearchDrawerOpen] = useState(false);

  // Modal state for creating new custom list
  const [newListModal, setNewListModal] = useState<{
    isOpen: boolean;
    type: 'watchlist' | 'watched';
  }>({
    isOpen: false,
    type: 'watched'
  });
  const [newListForm, setNewListForm] = useState({ title: '', description: '' });

  // Modal state for editing existing list
  const [editListModal, setEditListModal] = useState<{
    isOpen: boolean;
    list: MediaList | null;
  }>({
    isOpen: false,
    list: null
  });
  const [editListForm, setEditListForm] = useState({ title: '', description: '' });

  // Modal state for deleting list confirmation
  const [deleteListModal, setDeleteListModal] = useState<{
    isOpen: boolean;
    list: MediaList | null;
  }>({
    isOpen: false,
    list: null
  });

  // Initialize Nostr Extension check and WebSocket Service
  useEffect(() => {
    const service = new NostrService(DEFAULT_RELAYS);
    nostrServiceRef.current = service;

    service.connectRelays((statuses) => {
      setRelayStatuses({ ...statuses });
    });

    const checkExtension = () => {
      if (window.nostr) {
        setHasNostrExtension(true);
      }
    };
    checkExtension();
    const timer = setTimeout(checkExtension, 1000);

    return () => {
      clearTimeout(timer);
      service.close();
    };
  }, []);

  // Initialize activeSigner on load & handle auto-reconnect for NIP-46 Bunker
  useEffect(() => {
    if (!nostrUser) {
      activeSignerRef.current = null;
      return;
    }

    if (nostrUser.signerType === 'extension') {
      activeSignerRef.current = new Nip07Signer();
    } else if (nostrUser.signerType === 'readonly') {
      activeSignerRef.current = new ReadOnlySigner(nostrUser.pubkey);
    } else if (nostrUser.signerType === 'bunker' && nostrUser.bunkerUrl) {
      if (!activeSignerRef.current || (activeSignerRef.current as any).bunkerUrl !== nostrUser.bunkerUrl) {
        createBunkerSigner(nostrUser.bunkerUrl, nostrUser.bunkerClientSk)
          .then(signer => {
            activeSignerRef.current = signer;
          })
          .catch(err => {
            console.error("Auto-reconnect NIP-46 Bunker failed:", err);
          });
      }
    }

    if (nostrUser.pubkey) {
      syncFromNostr(nostrUser.pubkey);
    }
  }, [nostrUser?.pubkey, nostrUser?.signerType]);

  // Auto-resolve metadata on mount for any items in local storage missing details
  useEffect(() => {
    lists.forEach(list => {
      if (list.items.some(x => x.title === 'Loading from the TVDB...' || !x.poster || (x.type === 'movie' && !x.director) || (x.type === 'tv' && !x.creator))) {
        resolveListMetadata(list.id, list.items);
      }
    });
  }, []);

  // Debounced search effect
  useEffect(() => {
    if (!searchQuery.trim()) {
      setSearchResults([]);
      setIsLoading(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    setError(null);

    const delayDebounce = setTimeout(async () => {
      try {
        const response = await fetch(`/api/tvdb/search?query=${encodeURIComponent(searchQuery)}`);
        if (!response.ok) {
          throw new Error(`Search request failed with status ${response.status}`);
        }
        const json = await response.json();
        if (json.data) {
          const mapped: Media[] = json.data.flatMap((item: any) => {
            let mediaType: 'movie' | 'tv';
            if (item.type === 'series') {
              mediaType = 'tv';
            } else if (item.type === 'movie') {
              mediaType = 'movie';
            } else {
              return [];
            }

            return [{
              id: `${mediaType}-${item.tvdb_id}`,
              title: item.name,
              year: item.year || 'N/A',
              type: mediaType,
              poster: item.image || item.image_url || item.thumbnail || '',
              genres: Array.isArray(item.genres)
                ? item.genres.map((g: any) => typeof g === 'string' ? g : (g?.name || '')).filter(Boolean)
                : [],
              slug: item.slug || undefined,
              director: item.director || undefined,
              creator: item.network || undefined,
              overview: item.overview || undefined
            }];
          });
          setSearchResults(mapped);
        } else {
          setSearchResults([]);
        }
      } catch (err: any) {
        console.error('Search error:', err);
        setError(err.message || 'An error occurred while communicating with TheTVDB.');
      } finally {
        setIsLoading(false);
      }
    }, 450);

    return () => clearTimeout(delayDebounce);
  }, [searchQuery]);

  // Nostr auth functions
  const handleConnectExtension = async () => {
    if (!window.nostr) {
      alert("No NIP-07 extension detected. Please install Alby or nos2x, or use Remote Signer.");
      return;
    }

    try {
      const signer = new Nip07Signer();
      activeSignerRef.current = signer;
      const pubkey = await signer.getPublicKey();
      if (pubkey) {
        const user: NostrUser = { pubkey, readOnly: false, signerType: 'extension' };
        setNostrUser(user);
        localStorage.setItem('watchlistr_nostr_user', JSON.stringify(user));
      }
    } catch (err) {
      console.error("Failed to connect Nostr extension:", err);
      alert("Failed to get public key from extension.");
    }
  };

  const handleConnectBunker = async (bunkerUrl: string) => {
    if (!bunkerUrl.trim()) return;
    setBunkerConnecting(true);
    setBunkerError(null);
    setAuthChallengeUrl(null);

    try {
      const signer = await createBunkerSigner(bunkerUrl, undefined, (authUrl) => {
        setAuthChallengeUrl(authUrl);
      });
      activeSignerRef.current = signer;
      const pubkey = await signer.getPublicKey();

      const user: NostrUser = {
        pubkey,
        readOnly: false,
        signerType: 'bunker',
        bunkerUrl: bunkerUrl.trim(),
        bunkerClientSk: signer.clientSecretKeyHex
      };

      setNostrUser(user);
      localStorage.setItem('watchlistr_nostr_user', JSON.stringify(user));
      setBunkerInputUrl('');
    } catch (err: any) {
      console.error("Failed to connect NIP-46 Bunker:", err);
      setBunkerError(err.message || String(err));
    } finally {
      setBunkerConnecting(false);
    }
  };

  const handleStartNostrConnect = async () => {
    setIsNostrConnectListening(true);
    setBunkerError(null);
    setAuthChallengeUrl(null);

    const session = startNostrConnectSession(DEFAULT_RELAYS, (authUrl) => {
      setAuthChallengeUrl(authUrl);
    });

    setNostrConnectUri(session.uri);

    try {
      const signer = await session.listen();
      activeSignerRef.current = signer;
      const pubkey = await signer.getPublicKey();

      const user: NostrUser = {
        pubkey,
        readOnly: false,
        signerType: 'bunker',
        bunkerUrl: signer.bunkerUrl,
        bunkerClientSk: signer.clientSecretKeyHex
      };

      setNostrUser(user);
      localStorage.setItem('watchlistr_nostr_user', JSON.stringify(user));
      setNostrConnectUri(null);
    } catch (err: any) {
      console.error("Nostr Connect session failed:", err);
      setBunkerError(err.message || String(err));
    } finally {
      setIsNostrConnectListening(false);
    }
  };

  const handleConnectReadOnly = (rawKey: string) => {
    const hex = decodeNpubToHex(rawKey);
    if (!hex || hex.length !== 64) {
      alert("Invalid Nostr public key or npub format.");
      return;
    }
    const signer = new ReadOnlySigner(hex);
    activeSignerRef.current = signer;
    const user: NostrUser = { pubkey: hex, readOnly: true, signerType: 'readonly' };
    setNostrUser(user);
    localStorage.setItem('watchlistr_nostr_user', JSON.stringify(user));
    setReadOnlyInputKey('');
  };

  const logoutNostr = () => {
    if (activeSignerRef.current && 'close' in activeSignerRef.current) {
      try {
        (activeSignerRef.current as BunkerNip46Signer).close();
      } catch (e) {}
    }
    activeSignerRef.current = null;
    setNostrUser(null);
    setSelectedListId(null);
    localStorage.removeItem('watchlistr_nostr_user');

    setLists([
      {
        id: 'watchlist:default',
        title: 'To Watch',
        description: 'My default list of items to watch.',
        type: 'watchlist',
        items: [],
        createdAt: 0
      },
      {
        id: 'watched:default',
        title: 'Watched',
        description: 'My default list of watched items.',
        type: 'watched',
        items: [],
        createdAt: 0
      }
    ]);
    setFollowedPubkeys([]);
    setFollowedProfiles({});
    setFollowedListsMap({});
  };

  const publishListToNostr = async (list: MediaList) => {
    if (!nostrUser || nostrUser.readOnly || !nostrServiceRef.current || !activeSignerRef.current) return;

    const iTags = list.items.map(item => {
      const numericId = item.id.includes('-') ? item.id.split('-')[1] : item.id;
      const identifier = `ttvdb:${item.type === 'tv' ? 'series' : 'movie'}:${numericId}`;
      const urlHint = item.slug ? `https://thetvdb.com/${item.type === 'tv' ? 'series' : 'movies'}/${item.slug}` : "";
      const datestamp = item.watchedDate || "";
      const rating = item.userRating !== undefined ? item.userRating.toString() : "";
      return ["i", identifier, urlHint, datestamp, rating];
    });

    const unsignedEvent = {
      created_at: Math.floor(Date.now() / 1000),
      kind: 30016,
      tags: [
        ["d", list.id],
        ["title", cleanListTitle(list.title)],
        ["description", list.description],
        ...iTags
      ],
      content: ""
    };

    try {
      const signedEvent = await activeSignerRef.current.signEvent(unsignedEvent);
      await nostrServiceRef.current.publishEvent(signedEvent);
    } catch (err) {
      console.error(`Failed to publish list ${list.id} to Nostr:`, err);
    }
  };

  const syncFromNostr = async (pubkey: string) => {
    if (!nostrServiceRef.current) return;
    setIsSyncing(true);

    try {
      // 1. Fetch own lists (kind:30016)
      const events = await nostrServiceRef.current.fetchUserLists(pubkey);
      const remoteLists: MediaList[] = [];

      for (const event of events) {
        const dTag = event.tags.find(t => t[0] === 'd')?.[1];
        if (!dTag) continue;

        const rawTitle = event.tags.find(t => t[0] === 'title')?.[1] || dTag;
        const title = cleanListTitle(rawTitle);
        const description = event.tags.find(t => t[0] === 'description')?.[1] || '';
        const id = dTag;
        const type = (id.startsWith('watchlist:') || id === 'watchlist') ? 'watchlist' : 'watched';

        const items: Media[] = event.tags
          .filter(t => t[0] === 'i')
          .map(t => {
            const identifier = t[1] || '';
            const watchedDate = t[3] || '';
            const ratingStr = t[4] || '';

            let mediaType: 'movie' | 'tv' = 'movie';
            let mediaId = identifier;

            if (identifier.startsWith('ttvdb:')) {
              const parts = identifier.split(':');
              mediaType = parts[1] === 'series' ? 'tv' : 'movie';
              mediaId = `${mediaType}-${parts[2]}`;
            }

            const ratingNum = parseFloat(ratingStr);

            return {
              id: mediaId,
              title: 'Loading from the TVDB...',
              year: watchedDate ? watchedDate.split('-')[0] : '',
              type: mediaType,
              poster: '',
              genres: [],
              watchedDate,
              userRating: isNaN(ratingNum) ? undefined : ratingNum
            };
          });

        remoteLists.push({
          id,
          title,
          description,
          type,
          items,
          createdAt: event.created_at
        });
      }

      setLists(prev => {
        const merged = [...prev];
        remoteLists.forEach(remote => {
          const index = merged.findIndex(x => x.id === remote.id);
          if (index >= 0) {
            if (remote.createdAt > (merged[index].createdAt || 0) || merged[index].items.length === 0 || merged[index].createdAt === 0) {
              merged[index] = remote;
            }
          } else {
            merged.push(remote);
          }
        });
        return merged;
      });

      const watchlists = remoteLists.filter(x => x.type === 'watchlist');
      const watchedlists = remoteLists.filter(x => x.type === 'watched');

      if (watchlists.length > 0) {
        watchlists.sort((a, b) => b.createdAt - a.createdAt);
        setActiveWatchlistId(watchlists[0].id);
      }
      if (watchedlists.length > 0) {
        watchedlists.sort((a, b) => b.createdAt - a.createdAt);
        setActiveWatchedId(watchedlists[0].id);
      }

      remoteLists.forEach(list => {
        if (list.items.some(x => x.title === 'Loading from the TVDB...')) {
          resolveListMetadata(list.id, list.items);
        }
      });

      // 2. Fetch profile metadata (kind:0)
      const profileEvent = await nostrServiceRef.current.fetchUserProfile(pubkey);
      if (profileEvent) {
        try {
          const meta = JSON.parse(profileEvent.content);
          setNostrUser(prev => prev ? {
            ...prev,
            name: meta.display_name || meta.name || meta.username,
            picture: meta.picture
          } : null);
        } catch (e) {}
      }

      // 3. Fetch followed pubkeys (kind:10016)
      const remoteFollows = await nostrServiceRef.current.fetchUserFollows(pubkey);
      if (remoteFollows && remoteFollows.length > 0) {
        setFollowedPubkeys(remoteFollows);
        localStorage.setItem('watchlistr_followed_pubkeys', JSON.stringify(remoteFollows));
        loadFollowedData(remoteFollows);
      }
    } catch (err) {
      console.error("Failed to sync from Nostr:", err);
    } finally {
      setIsSyncing(false);
    }
  };

  // Helper to decode npub to hex
  const decodeNpubToHex = (input: string): string => {
    const trimmed = input.trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return trimmed.toLowerCase();
    }
    if (trimmed.startsWith('npub1')) {
      const ALPHABET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
      const pos = trimmed.lastIndexOf('1');
      const data: number[] = [];
      for (let i = pos + 1; i < trimmed.length; i++) {
        const d = ALPHABET.indexOf(trimmed[i].toLowerCase());
        if (d !== -1) data.push(d);
      }
      const bytes: number[] = [];
      let current = 0;
      let bits = 0;
      for (let i = 0; i < data.length - 6; i++) {
        current = (current << 5) | data[i];
        bits += 5;
        while (bits >= 8) {
          bits -= 8;
          bytes.push((current >> bits) & 0xff);
        }
      }
      return bytes.map(b => b.toString(16).padStart(2, '0')).join('');
    }
    return trimmed;
  };

  // Load profile metadata and kind:30016 lists for followed pubkeys
  const loadFollowedData = async (pubkeys: string[]) => {
    if (!nostrServiceRef.current || pubkeys.length === 0) return;

    pubkeys.forEach(async (pk) => {
      if (!followedProfiles[pk]) {
        const metaEvent = await nostrServiceRef.current?.fetchUserProfile(pk);
        if (metaEvent) {
          try {
            const meta = JSON.parse(metaEvent.content);
            setFollowedProfiles(prev => ({
              ...prev,
              [pk]: {
                name: meta.display_name || meta.name || meta.username || `${pk.substring(0, 8)}...`,
                picture: meta.picture
              }
            }));
          } catch (e) {}
        }
      }
    });

    const remoteEvents = await nostrServiceRef.current.fetchFollowedLists(pubkeys);
    const parsedMap: Record<string, MediaList[]> = {};

    remoteEvents.forEach(event => {
      const pk = event.pubkey || '';
      if (!pk) return;
      if (!parsedMap[pk]) parsedMap[pk] = [];
      const dTag = event.tags.find(t => t[0] === 'd')?.[1] || 'watchlist:default';
      const titleTag = event.tags.find(t => t[0] === 'title')?.[1] || dTag;
      const descTag = event.tags.find(t => t[0] === 'description')?.[1] || '';
      const isWatchlist = dTag.startsWith('watchlist:') || dTag === 'watchlist';
      const type: 'watchlist' | 'watched' = isWatchlist ? 'watchlist' : 'watched';

      const items: Media[] = event.tags
        .filter(t => t[0] === 'i')
        .map(t => {
          const identifier = t[1] || '';
          const datestamp = t[3] || '';
          const ratingStr = t[4] || '';

          let mediaType: 'movie' | 'tv' = 'movie';
          let mediaId = identifier;

          if (identifier.startsWith('ttvdb:')) {
            const parts = identifier.split(':');
            mediaType = parts[1] === 'series' ? 'tv' : 'movie';
            mediaId = `${mediaType}-${parts[2]}`;
          }

          const ratingNum = parseFloat(ratingStr);
          return {
            id: mediaId,
            title: 'Loading from the TVDB...',
            year: datestamp ? datestamp.split('-')[0] : '',
            type: mediaType,
            poster: '',
            genres: [],
            watchedDate: datestamp || undefined,
            userRating: isNaN(ratingNum) ? undefined : ratingNum
          };
        });

      parsedMap[pk].push({
        id: `social:${pk}:${dTag}`,
        title: cleanListTitle(titleTag),
        description: descTag,
        type,
        items,
        createdAt: event.created_at
      });
    });

    setFollowedListsMap(parsedMap);

    Object.values(parsedMap).forEach(userLists => {
      userLists.forEach(list => {
        if (list.items.some(x => x.title === 'Loading from the TVDB...' || !x.poster || (x.type === 'movie' && !x.director) || (x.type === 'tv' && !x.creator))) {
          resolveListMetadata(list.id, list.items);
        }
      });
    });
  };

  // Load global explore lists (kind:30016)
  const loadExploreData = async (isInitial: boolean = false) => {
    if (!nostrServiceRef.current) return;
    if (isInitial) {
      setIsExploreLoading(true);
    } else {
      if (isExploreLoadingMore || !hasMoreExplore) return;
      setIsExploreLoadingMore(true);
    }

    try {
      const untilParam = isInitial ? undefined : exploreUntil;
      const remoteEvents = await nostrServiceRef.current.fetchExploreLists(20, untilParam);

      if (remoteEvents.length === 0) {
        setHasMoreExplore(false);
        setIsExploreLoading(false);
        setIsExploreLoadingMore(false);
        return;
      }

      // Track oldest created_at for pagination
      const oldestTimestamp = Math.min(...remoteEvents.map(e => e.created_at));
      setExploreUntil(oldestTimestamp - 1);

      // Collect pubkeys and fetch profiles
      const allPubkeys = remoteEvents.map(e => e.pubkey).filter((pk): pk is string => Boolean(pk));
      const pubkeysToFetch = Array.from(new Set(allPubkeys)).filter(
        pk => !exploreProfiles[pk] && !followedProfiles[pk]
      );

      pubkeysToFetch.forEach(async (pk) => {
        const metaEvent = await nostrServiceRef.current?.fetchUserProfile(pk);
        if (metaEvent) {
          try {
            const meta = JSON.parse(metaEvent.content);
            setExploreProfiles(prev => ({
              ...prev,
              [pk]: {
                name: meta.display_name || meta.name || meta.username || `${pk.substring(0, 8)}...`,
                picture: meta.picture
              }
            }));
          } catch (e) {}
        }
      });

      const newLists: MediaList[] = [];
      remoteEvents.forEach(event => {
        const pk = event.pubkey || '';
        if (!pk) return;
        if (nostrUser?.pubkey && pk === nostrUser.pubkey) return;
        const dTag = event.tags.find(t => t[0] === 'd')?.[1] || 'watchlist:default';
        const titleTag = event.tags.find(t => t[0] === 'title')?.[1] || dTag;
        const descTag = event.tags.find(t => t[0] === 'description')?.[1] || '';
        const isWatchlist = dTag.startsWith('watchlist:') || dTag === 'watchlist';
        const type: 'watchlist' | 'watched' = isWatchlist ? 'watchlist' : 'watched';

        // Filter out to-watch / watchlist lists (keep ONLY watched lists)
        if (type !== 'watched') return;

        const listId = `social:${pk}:${dTag}`;

        const items: Media[] = event.tags
          .filter(t => t[0] === 'i')
          .map(t => {
            const identifier = t[1] || '';
            const datestamp = t[3] || '';
            const ratingStr = t[4] || '';

            let mediaType: 'movie' | 'tv' = 'movie';
            let mediaId = identifier;

            if (identifier.startsWith('ttvdb:')) {
              const parts = identifier.split(':');
              mediaType = parts[1] === 'series' ? 'tv' : 'movie';
              mediaId = `${mediaType}-${parts[2]}`;
            }

            const ratingNum = parseFloat(ratingStr);
            return {
              id: mediaId,
              title: 'Loading from the TVDB...',
              year: datestamp ? datestamp.split('-')[0] : '',
              type: mediaType,
              poster: '',
              genres: [],
              watchedDate: datestamp || undefined,
              userRating: isNaN(ratingNum) ? undefined : ratingNum
            };
          });

        // Filter out empty lists
        if (items.length === 0) return;

        newLists.push({
          id: listId,
          title: cleanListTitle(titleTag),
          description: descTag,
          type,
          items,
          createdAt: event.created_at
        });
      });

      setExploreLists(prev => {
        const existingIds = new Set(prev.map(l => l.id));
        const filteredNew = newLists.filter(l => !existingIds.has(l.id));
        const combined = isInitial ? newLists : [...prev, ...filteredNew];
        return combined.sort((a, b) => b.createdAt - a.createdAt);
      });

      // Trigger TVDB metadata resolution for new explore items
      newLists.forEach(list => {
        if (list.items.some(x => x.title === 'Loading from the TVDB...' || !x.poster || (x.type === 'movie' && !x.director) || (x.type === 'tv' && !x.creator))) {
          resolveListMetadata(list.id, list.items);
        }
      });

      if (remoteEvents.length < 20) {
        setHasMoreExplore(false);
      }
    } catch (err) {
      console.error("Error loading explore lists:", err);
    } finally {
      setIsExploreLoading(false);
      setIsExploreLoadingMore(false);
    }
  };

  // IntersectionObserver for infinite scrolling in Explore tab
  useEffect(() => {
    if (activeHubTab !== 'explore') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMoreExplore && !isExploreLoading && !isExploreLoadingMore) {
          loadExploreData(false);
        }
      },
      { threshold: 0.1, rootMargin: '300px' }
    );

    const currentRef = exploreObserverRef.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) observer.unobserve(currentRef);
      observer.disconnect();
    };
  }, [activeHubTab, hasMoreExplore, isExploreLoading, isExploreLoadingMore, exploreUntil]);

  useEffect(() => {
    if (followedPubkeys.length > 0 && nostrServiceRef.current) {
      loadFollowedData(followedPubkeys);
    }
  }, [followedPubkeys.length]);

  const handleFollowUser = async (rawKey: string) => {
    setFollowError(null);
    const hex = decodeNpubToHex(rawKey);
    if (!hex || hex.length !== 64) {
      setFollowError('Invalid Nostr public key or npub format.');
      return;
    }
    if (followedPubkeys.includes(hex)) {
      setFollowError('You are already following this profile.');
      return;
    }

    const nextFollows = [...followedPubkeys, hex];
    setFollowedPubkeys(nextFollows);
    localStorage.setItem('watchlistr_followed_pubkeys', JSON.stringify(nextFollows));

    setFollowInputKey('');
    setIsFollowModalOpen(false);

    loadFollowedData(nextFollows);
    publishFollowListToNostr(nextFollows);
  };

  const handleUnfollowUser = (hex: string) => {
    const nextFollows = followedPubkeys.filter(k => k !== hex);
    setFollowedPubkeys(nextFollows);
    localStorage.setItem('watchlistr_followed_pubkeys', JSON.stringify(nextFollows));

    const nextMap = { ...followedListsMap };
    delete nextMap[hex];
    setFollowedListsMap(nextMap);

    publishFollowListToNostr(nextFollows);
  };

  const publishFollowListToNostr = async (keysToPublish: string[]) => {
    if (!nostrUser || nostrUser.readOnly || !nostrServiceRef.current || !activeSignerRef.current) return;
    try {
      const pTags = keysToPublish.map(pk => ["p", pk]);
      const unsignedEvent = {
        created_at: Math.floor(Date.now() / 1000),
        kind: 10016,
        tags: pTags,
        content: ""
      };
      const signedEvent = await activeSignerRef.current.signEvent(unsignedEvent);
      await nostrServiceRef.current.publishEvent(signedEvent);
    } catch (e) {
      console.error("Failed to publish kind:10016 follow list:", e);
    }
  };

  const fetchTVShowrunner = async (seriesId: string): Promise<string | undefined> => {
    try {
      const epRes = await fetch(`/api/tvdb/series/${seriesId}/episodes/default?page=0`);
      if (epRes.ok) {
        const epJson = await epRes.json();
        const ep1 = epJson.data?.episodes?.find((e: any) => e.seasonNumber === 1 && e.number === 1) || epJson.data?.episodes?.[0];
        if (ep1?.id) {
          const epExtRes = await fetch(`/api/tvdb/episodes/${ep1.id}/extended`);
          if (epExtRes.ok) {
            const epExtJson = await epExtRes.json();
            const writers = epExtJson.data?.characters
              ?.filter((c: any) => c.peopleType === 'Writer')
              .map((c: any) => c.personName)
              .filter(Boolean);
            if (writers && writers.length > 0) {
              return Array.from(new Set<string>(writers)).join(', ');
            }
          }
        }
      }
    } catch (e) {}
    return undefined;
  };

  const resolveListMetadata = async (listId: string, items: Media[]) => {
    const unresolved = items.filter(item => item.title === 'Loading from the TVDB...' || !item.poster || (item.type === 'movie' && !item.director) || (item.type === 'tv' && !item.creator));
    if (unresolved.length === 0) return;

    const resolved = await Promise.all(unresolved.map(async (item) => {
      const numericId = item.id.includes('-') ? item.id.split('-')[1] : item.id;
      const endpoint = item.type === 'tv'
        ? `/api/tvdb/series/${numericId}/extended`
        : `/api/tvdb/movies/${numericId}/extended`;

      try {
        let res = await fetch(endpoint);
        if (!res.ok && endpoint.endsWith('/extended')) {
          const stdEndpoint = item.type === 'tv'
            ? `/api/tvdb/series/${numericId}`
            : `/api/tvdb/movies/${numericId}`;
          res = await fetch(stdEndpoint);
        }
        if (!res.ok) throw new Error();
        const json = await res.json();
        const data = json.data;
        if (data) {
          const directorName = item.type === 'movie'
            ? (data.director || data.characters?.find((c: any) => c.peopleType === 'Director')?.personName || undefined)
            : undefined;

          const networkName = item.type === 'tv'
            ? (data.network || data.originalNetwork?.name || (Array.isArray(data.companies?.network) ? data.companies.network[0]?.name : undefined) || undefined)
            : undefined;

          let showrunnerName: string | undefined = undefined;
          if (item.type === 'tv') {
            showrunnerName = await fetchTVShowrunner(numericId);
          }

          const posterUrl = data.image || data.image_url || data.thumbnail || '';

          return {
            ...item,
            title: item.title === 'Loading from the TVDB...' ? (data.name || data.translations?.eng || 'Unknown Title') : item.title,
            year: item.year && item.year !== 'N/A' ? item.year : (data.year || (data.first_air_time ? data.first_air_time.split('-')[0] : (data.firstAired ? data.firstAired.split('-')[0] : 'N/A'))),
            poster: posterUrl || item.poster || '',
            genres: data.genres ? (Array.isArray(data.genres) ? data.genres.map((g: any) => typeof g === 'string' ? g : (g?.name || '')).filter(Boolean) : []) : (item.genres || []),
            slug: data.slug || item.slug || undefined,
            overview: data.overview || item.overview || undefined,
            director: directorName || item.director,
            creator: showrunnerName || networkName || item.creator
          };
        }
      } catch (e) {
        console.error("Error resolving metadata for item", item.id, e);
      }
      return { ...item, title: item.title === 'Loading from the TVDB...' ? 'Unknown Title' : item.title };
    }));

    setLists(prev => prev.map(list => {
      if (list.id !== listId) return list;
      return {
        ...list,
        items: list.items.map(item => {
          const found = resolved.find(r => r.id === item.id);
          return found || item;
        })
      };
    }));

    setFollowedListsMap(prev => {
      const updated = { ...prev };
      let changed = false;
      Object.keys(updated).forEach(pk => {
        updated[pk] = updated[pk].map(list => {
          if (list.id !== listId) return list;
          changed = true;
          return {
            ...list,
            items: list.items.map(item => {
              const found = resolved.find(r => r.id === item.id);
              return found || item;
            })
          };
        });
      });
      return changed ? updated : prev;
    });

    setExploreLists(prev => prev.map(list => {
      if (list.id !== listId) return list;
      return {
        ...list,
        items: list.items.map(item => {
          const found = resolved.find(r => r.id === item.id);
          return found || item;
        })
      };
    }));
  };

  const createNewList = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newListForm.title.trim()) return;

    const type = newListModal.type;
    const cleanTitle = newListForm.title.trim();
    const id = `${type}:${cleanTitle.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${Math.floor(Math.random() * 10000)}`;

    const newList: MediaList = {
      id,
      title: cleanTitle,
      description: newListForm.description.trim(),
      type,
      items: [],
      createdAt: Math.floor(Date.now() / 1000)
    };

    setLists(prev => [...prev, newList]);
    if (type === 'watchlist') {
      setActiveWatchlistId(id);
    } else {
      setActiveWatchedId(id);
    }

    publishListToNostr(newList);

    setNewListForm({ title: '', description: '' });
    setNewListModal({ isOpen: false, type: 'watched' });
  };

  const openEditListModal = (list: MediaList) => {
    setEditListForm({
      title: list.title,
      description: list.description || ''
    });
    setEditListModal({ isOpen: true, list });
  };

  const saveEditList = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editListModal.list || !editListForm.title.trim()) return;

    const updatedTitle = editListForm.title.trim();
    const updatedDesc = editListForm.description.trim();
    const targetId = editListModal.list.id;

    const updatedList: MediaList = {
      ...editListModal.list,
      title: updatedTitle,
      description: updatedDesc
    };

    setLists(prev => prev.map(l => l.id === targetId ? updatedList : l));
    publishListToNostr(updatedList);
    setEditListModal({ isOpen: false, list: null });
  };

  const deleteListFromNostr = async (listId: string) => {
    if (!nostrUser || nostrUser.readOnly || !nostrServiceRef.current || !activeSignerRef.current) return;
    try {
      const unsignedEvent = {
        created_at: Math.floor(Date.now() / 1000),
        kind: 5,
        tags: [
          ["a", `30016:${nostrUser.pubkey}:${listId}`],
          ["d", listId]
        ],
        content: `Deleted list ${listId}`
      };
      const signedEvent = await activeSignerRef.current.signEvent(unsignedEvent);
      await nostrServiceRef.current.publishEvent(signedEvent);
    } catch (err) {
      console.error(`Failed to publish list deletion for ${listId}:`, err);
    }
  };

  const confirmDeleteList = (list: MediaList) => {
    setDeleteListModal({ isOpen: true, list });
  };

  const executeDeleteList = () => {
    if (!deleteListModal.list) return;

    const targetId = deleteListModal.list.id;
    setLists(prev => prev.filter(l => l.id !== targetId));
    deleteListFromNostr(targetId);

    setDeleteListModal({ isOpen: false, list: null });
    setSelectedListId(null);
  };

  // Actions
  const defaultWatchlistId = 'watchlist:default';

  const isInDefaultWatchlist = (itemId: string): boolean => {
    const defaultList = lists.find(x => x.id === defaultWatchlistId) || lists.find(x => x.type === 'watchlist');
    return defaultList ? defaultList.items.some(x => x.id === itemId) : false;
  };

  const toggleDefaultWatchlist = (item: Media) => {
    const defaultList = lists.find(x => x.id === defaultWatchlistId) || lists.find(x => x.type === 'watchlist');
    const targetId = defaultList ? defaultList.id : defaultWatchlistId;
    if (isInDefaultWatchlist(item.id)) {
      removeFromWatchlist(item.id, targetId);
    } else {
      addToWatchlist(item, targetId);
    }
  };

  const renderWatchlistRibbon = (item: Media) => {
    const inDefault = isInDefaultWatchlist(item.id);
    const darkGreen = '#15803d';
    return (
      <button
        className={`btn btn-action-icon ${inDefault ? 'ribbon-active' : 'ribbon-inactive'}`}
        onClick={(e) => {
          e.stopPropagation();
          toggleDefaultWatchlist(item);
        }}
        title={inDefault ? "In To-Watch list (Click to remove)" : "Add to default To-Watch list"}
        style={{
          padding: '6px',
          borderRadius: 'var(--radius-sm)',
          color: inDefault ? darkGreen : 'var(--text-tertiary)',
          backgroundColor: inDefault ? 'rgba(21, 128, 61, 0.14)' : 'transparent',
          border: inDefault ? '1px solid rgba(21, 128, 61, 0.35)' : '1px solid var(--border-color)',
          transition: 'all var(--transition-fast)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center'
        }}
      >
        <Bookmark size={16} fill={inDefault ? darkGreen : 'none'} />
      </button>
    );
  };

  const addToWatchlist = (item: Media, targetListId: string = activeWatchlistId) => {
    let updatedList: MediaList | null = null;
    setLists(prev => {
      const next = prev.map(list => {
        if (list.id === targetListId) {
          if (list.items.some(x => x.id === item.id)) return list;
          updatedList = { ...list, items: [item, ...list.items], createdAt: Math.floor(Date.now() / 1000) };
          return updatedList;
        }
        return list;
      });
      if (updatedList) {
        publishListToNostr(updatedList);
      }
      return next;
    });
  };

  const openLogWatchedModal = (item: Media, sourceList: 'search' | 'watchlist' | 'edit', targetListId?: string) => {
    const dateStr = item.watchedDate || new Date().toISOString().split('T')[0];
    const parts = dateStr.split('-');

    let validWatchedId: string = targetListId || '';
    const targetList = lists.find(x => x.id === targetListId);
    if (!targetList || targetList.type !== 'watched') {
      const defaultWatched = lists.find(x => x.id === 'watched:default') || lists.find(x => x.type === 'watched');
      validWatchedId = defaultWatched ? defaultWatched.id : 'watched:default';
    }

    setLogModal({
      isOpen: true,
      item,
      year: parts[0] || '',
      month: parts[1] || '',
      day: parts[2] || '',
      rating: item.userRating !== undefined ? Math.round(item.userRating).toString() : '8',
      sourceList,
      targetListId: validWatchedId
    });
  };

  const saveWatchedDetails = () => {
    if (!logModal.item) return;

    let dateStr = '';
    if (logModal.year) {
      dateStr = logModal.year;
      if (logModal.month) {
        dateStr += `-${logModal.month}`;
        if (logModal.day) {
          dateStr += `-${logModal.day}`;
        }
      }
    }

    const ratingNum = parseInt(logModal.rating, 10);
    const updatedItem: Media = {
      ...logModal.item,
      watchedDate: dateStr || undefined,
      userRating: isNaN(ratingNum) ? undefined : ratingNum
    };

    const targetListId = logModal.targetListId || activeWatchedId;
    let updatedWatchlist: MediaList | null = null;
    let updatedWatchedlist: MediaList | null = null;

    setLists(prev => {
      const next = prev.map(list => {
        if (list.type === 'watchlist') {
          if (list.items.some(x => x.id === updatedItem.id)) {
            updatedWatchlist = { ...list, items: list.items.filter(x => x.id !== updatedItem.id), createdAt: Math.floor(Date.now() / 1000) };
            return updatedWatchlist;
          }
        }
        if (list.id === targetListId) {
          const exists = list.items.some(x => x.id === updatedItem.id);
          const filtered = list.items.filter(x => x.id !== updatedItem.id);
          updatedWatchedlist = {
            ...list,
            items: exists && logModal.sourceList === 'edit'
              ? list.items.map(x => x.id === updatedItem.id ? updatedItem : x)
              : [updatedItem, ...filtered],
            createdAt: Math.floor(Date.now() / 1000)
          };
          return updatedWatchedlist;
        }
        return list;
      });

      if (updatedWatchlist) publishListToNostr(updatedWatchlist);
      if (updatedWatchedlist) publishListToNostr(updatedWatchedlist);

      return next;
    });

    setLogModal(prev => ({ ...prev, isOpen: false, item: null }));
  };

  const setTodayDate = () => {
    const today = new Date();
    setLogModal(prev => ({
      ...prev,
      year: today.getFullYear().toString(),
      month: (today.getMonth() + 1).toString().padStart(2, '0'),
      day: today.getDate().toString().padStart(2, '0')
    }));
  };

  const removeFromWatchlist = (id: string, listId: string = activeWatchlistId) => {
    let updatedList: MediaList | null = null;
    setLists(prev => {
      const next = prev.map(list => {
        if (list.id === listId) {
          updatedList = { ...list, items: list.items.filter(x => x.id !== id), createdAt: Math.floor(Date.now() / 1000) };
          return updatedList;
        }
        return list;
      });
      if (updatedList) {
        publishListToNostr(updatedList);
      }
      return next;
    });
  };

  const removeFromWatched = (id: string, listId: string = activeWatchedId) => {
    let updatedList: MediaList | null = null;
    setLists(prev => {
      const next = prev.map(list => {
        if (list.id === listId) {
          updatedList = { ...list, items: list.items.filter(x => x.id !== id), createdAt: Math.floor(Date.now() / 1000) };
          return updatedList;
        }
        return list;
      });
      if (updatedList) {
        publishListToNostr(updatedList);
      }
      return next;
    });
  };

  const openDetailsModal = async (item: Media) => {
    setDetailsModal({
      isOpen: true,
      item,
      isLoading: true,
      error: null,
      extendedInfo: null
    });

    const numericId = item.id.includes('-') ? item.id.split('-')[1] : item.id;
    const endpoint = item.type === 'tv'
      ? `/api/tvdb/series/${numericId}/extended`
      : `/api/tvdb/movies/${numericId}/extended`;

    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error(`Failed to fetch details: ${response.status}`);
      }
      const json = await response.json();
      let extendedData = json.data || null;

      if (item.type === 'tv' && extendedData) {
        const showrunner = await fetchTVShowrunner(numericId);
        if (showrunner) {
          extendedData = {
            ...extendedData,
            showrunner
          };
        }
      }

      setDetailsModal(prev => ({
        ...prev,
        isLoading: false,
        extendedInfo: extendedData
      }));
    } catch (err: any) {
      console.error('Error fetching extended info:', err);
      setDetailsModal(prev => ({
        ...prev,
        isLoading: false,
        error: 'Could not load details from TheTVDB.'
      }));
    }
  };

  const closeDetailsModal = () => {
    setDetailsModal(prev => ({ ...prev, isOpen: false, item: null, extendedInfo: null }));
  };

  const clearSearch = () => {
    setSearchQuery('');
    setSearchResults([]);
  };

  const getMonthName = (m: string) => {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const idx = parseInt(m, 10) - 1;
    return months[idx] || m;
  };

  const getDaysInMonth = (yearStr: string, monthStr: string) => {
    if (!yearStr || !monthStr) return 31;
    const y = parseInt(yearStr, 10);
    const m = parseInt(monthStr, 10);
    if (isNaN(y) || isNaN(m)) return 31;
    return new Date(y, m, 0).getDate();
  };

  const getDayOptions = (yearStr: string, monthStr: string) => {
    const daysCount = getDaysInMonth(yearStr, monthStr);
    const options = [];
    for (let i = 1; i <= daysCount; i++) {
      const val = i.toString().padStart(2, '0');
      options.push({ value: val, label: i.toString() });
    }
    return options;
  };

  const getYearOptions = (selectedYear?: string) => {
    const currentYear = new Date().getFullYear();
    const years: string[] = [];
    for (let y = currentYear; y >= 1900; y--) {
      years.push(y.toString());
    }
    if (selectedYear && !years.includes(selectedYear) && !isNaN(parseInt(selectedYear, 10))) {
      years.unshift(selectedYear);
    }
    return years;
  };

  const ListCardPosterStrip: React.FC<{ items: Media[] }> = ({ items }) => {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const [maxSlots, setMaxSlots] = useState<number>(5);

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;

      const updateSlots = (width: number) => {
        const calculated = Math.max(1, Math.floor((width + 6) / 42));
        setMaxSlots(calculated);
      };

      updateSlots(el.getBoundingClientRect().width);

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          if (entry.contentRect.width > 0) {
            updateSlots(entry.contentRect.width);
          }
        }
      });

      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    if (!items || items.length === 0) {
      return (
        <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', fontStyle: 'italic', padding: '4px 0' }}>
          Empty list
        </div>
      );
    }

    const showOverflow = items.length > maxSlots;
    const visibleItems = showOverflow ? items.slice(0, maxSlots - 1) : items.slice(0, maxSlots);
    const remainingCount = items.length - visibleItems.length;

    return (
      <div ref={containerRef} style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden', width: '100%' }}>
        {visibleItems.map((item, idx) => (
          <div
            key={item.id || `${item.title}-${idx}`}
            style={{
              width: '36px',
              height: '52px',
              borderRadius: 'var(--radius-sm)',
              overflow: 'hidden',
              backgroundColor: 'var(--bg-tertiary)',
              flexShrink: 0,
              border: '1px solid var(--border-color)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center'
            }}
            title={item.title}
          >
            {item.poster ? (
              <img src={item.poster} alt={item.title} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--text-tertiary)', textAlign: 'center', padding: '2px' }}>
                {item.type === 'tv' ? <Tv size={14} /> : <Film size={14} />}
              </span>
            )}
          </div>
        ))}

        {showOverflow && (
          <div
            style={{
              width: '36px',
              height: '52px',
              borderRadius: 'var(--radius-sm)',
              backgroundColor: 'var(--bg-tertiary)',
              border: '1px solid var(--border-color)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: '0.75rem',
              fontWeight: 750,
              color: 'var(--accent-color)',
              flexShrink: 0
            }}
            title={`${remainingCount} more item${remainingCount === 1 ? '' : 's'}`}
          >
            +{remainingCount}
          </div>
        )}
      </div>
    );
  };

  const isSocialList = selectedListId ? selectedListId.startsWith('social:') : false;
  let currentList: MediaList | undefined;
  let socialProfile: { name?: string; picture?: string; pubkey?: string } | undefined;

  if (isSocialList && selectedListId) {
    const parts = selectedListId.split(':');
    const pubkey = parts[1];
    const userLists = followedListsMap[pubkey] || exploreLists.filter(l => l.id.startsWith(`social:${pubkey}:`));
    currentList = userLists.find(x => x.id === selectedListId) || exploreLists.find(x => x.id === selectedListId);
    const profile = followedProfiles[pubkey] || exploreProfiles[pubkey];
    socialProfile = {
      pubkey,
      name: profile?.name || `${pubkey.substring(0, 8)}...`,
      picture: profile?.picture
    };
  } else {
    currentList = lists.find(x => x.id === selectedListId);
  }

  return (
    <div className="app-container">
      {/* VIEW 1: LANDING PAGE (Unauthenticated / Sign-In Only) */}
      {!nostrUser ? (
        <div className="hub-layout">
          <div className="hub-hero">
            <h1 className="landing-logo" id="main-title" style={{ fontSize: '3rem', marginBottom: '0.2rem' }}>Watchlistr</h1>
            <p className="landing-tagline" style={{ margin: 0, fontSize: '1.1rem' }}>
              <a href="#" style={{ color: 'inherit', textDecoration: 'none' }}>Powered</a> by{' '}
              <a
                href="https://github.com/nostr-protocol/nostr"
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--accent-color)', textDecoration: 'underline' }}
              >
                Nostr
              </a>
            </p>

            {/* Multi-Tab Nostr Auth Card */}
            <div style={{ width: '100%', maxWidth: '540px', margin: '1.5rem auto' }}>
              <div className="plugin-notice-card" style={{ flexDirection: 'column', gap: '0.75rem', padding: '1.25rem' }}>
                <div className="auth-tabs" style={{ width: '100%', justifyContent: 'center' }}>
                  <button
                    className={`auth-tab ${activeAuthTab === 'bunker' ? 'active' : ''}`}
                    onClick={() => setActiveAuthTab('bunker')}
                  >
                    <Smartphone size={16} /> Remote Signer (NIP-46)
                  </button>
                  <button
                    className={`auth-tab ${activeAuthTab === 'extension' ? 'active' : ''}`}
                    onClick={() => setActiveAuthTab('extension')}
                  >
                    <Check size={16} /> Extension (NIP-07)
                  </button>
                  <button
                    className={`auth-tab ${activeAuthTab === 'readonly' ? 'active' : ''}`}
                    onClick={() => setActiveAuthTab('readonly')}
                  >
                    <Key size={16} /> Read-Only
                  </button>
                </div>

                {activeAuthTab === 'bunker' ? (
                  <div style={{ textAlign: 'left', width: '100%' }}>
                    <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '8px' }}>
                      <button
                        type="button"
                        className={`btn btn-small ${bunkerSubMode === 'nostrconnect' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => { setBunkerSubMode('nostrconnect'); setBunkerError(null); }}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '0.8rem' }}
                      >
                        <Smartphone size={14} /> Nostr Connect (QR / Link)
                      </button>
                      <button
                        type="button"
                        className={`btn btn-small ${bunkerSubMode === 'manual' ? 'btn-primary' : 'btn-secondary'}`}
                        onClick={() => { setBunkerSubMode('manual'); setBunkerError(null); }}
                        style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '0.8rem' }}
                      >
                        <Key size={14} /> Bunker URI
                      </button>
                    </div>

                    {bunkerSubMode === 'nostrconnect' ? (
                      <div style={{ textAlign: 'center', padding: '0.25rem 0' }}>
                        {!nostrConnectUri && !isNostrConnectListening ? (
                          <div>
                            <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                              Scan a QR code or tap the deep link using a compatible remote signer.
                            </p>
                            <button
                              className="btn btn-primary btn-large"
                              type="button"
                              onClick={handleStartNostrConnect}
                              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px' }}
                            >
                              <Smartphone size={18} /> Start Nostr Connect Session
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '10px' }}>
                            <div style={{ backgroundColor: '#ffffff', padding: '10px', borderRadius: 'var(--radius-md)', display: 'inline-block', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                              <img
                                src={`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(nostrConnectUri || '')}`}
                                alt="Nostr Connect QR Code"
                                width={180}
                                height={180}
                                style={{ display: 'block' }}
                              />
                            </div>
                            <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                              <span style={{ width: '8px', height: '8px', backgroundColor: '#3b82f6', borderRadius: '50%', display: 'inline-block', animation: 'pulse 1.5s infinite' }}></span>
                              Waiting for remote signer authorization...
                            </div>
                            <div style={{ display: 'flex', gap: '8px', width: '100%' }}>
                              <a
                                href={nostrConnectUri || '#'}
                                className="btn btn-primary btn-small"
                                style={{ flex: 1, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '6px', color: '#ffffff' }}
                              >
                                <Smartphone size={14} /> Open Signer App
                              </a>
                              <button
                                type="button"
                                className="btn btn-secondary btn-small"
                                onClick={() => {
                                  if (nostrConnectUri) {
                                    navigator.clipboard.writeText(nostrConnectUri);
                                    setCopiedLink(true);
                                    setTimeout(() => setCopiedLink(false), 2000);
                                  }
                                }}
                                style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}
                              >
                                <Copy size={14} /> {copiedLink ? 'Copied!' : 'Copy'}
                              </button>
                            </div>
                            <button
                              type="button"
                              className="btn btn-secondary btn-small"
                              onClick={() => {
                                setNostrConnectUri(null);
                                setIsNostrConnectListening(false);
                              }}
                              style={{ fontSize: '0.75rem', opacity: 0.8 }}
                            >
                              Cancel
                            </button>
                          </div>
                        )}

                        {bunkerError && (
                          <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#ef4444', backgroundColor: 'rgba(239, 68, 68, 0.1)', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
                            {bunkerError}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div>
                        <p style={{ margin: '0 0 0.5rem 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                          Paste a <code>bunker://</code> URI manually from your remote signer:
                        </p>
                        <form onSubmit={(e) => { e.preventDefault(); handleConnectBunker(bunkerInputUrl); }}>
                          <textarea
                            className="input-field"
                            placeholder="bunker://<remote-signer-pubkey>?relay=wss://...&secret=..."
                            rows={4}
                            value={bunkerInputUrl}
                            onChange={(e) => setBunkerInputUrl(e.target.value)}
                            style={{ marginBottom: '0.5rem', fontFamily: 'monospace', fontSize: '0.85rem', resize: 'vertical', width: '100%', wordBreak: 'break-all' }}
                            required
                          />
                          {authChallengeUrl && (
                            <div style={{ backgroundColor: 'rgba(21, 128, 61, 0.15)', border: '1px solid #15803d', padding: '10px 14px', borderRadius: 'var(--radius-md)', marginBottom: '0.75rem', fontSize: '0.85rem' }}>
                              <strong>🔑 Action Required in Signer App:</strong>
                              <p style={{ margin: '4px 0 8px 0' }}>
                                Please authorize the connection request in your remote signer application, or tap below:
                              </p>
                              <a href={authChallengeUrl} target="_blank" rel="noreferrer" className="btn btn-primary btn-small">
                                Open Authorization Link
                              </a>
                            </div>
                          )}
                          {bunkerError && (
                            <div style={{ fontSize: '0.85rem', color: '#ef4444', marginBottom: '0.5rem', backgroundColor: 'rgba(239, 68, 68, 0.1)', padding: '8px 12px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>{bunkerError}</div>
                          )}
                          <button className="btn btn-primary btn-large" type="submit" disabled={bunkerConnecting} style={{ width: '100%' }}>
                            {bunkerConnecting ? 'Connecting NIP-46 Bunker...' : 'Connect Remote Signer (NIP-46)'}
                          </button>
                        </form>
                      </div>
                    )}
                  </div>
                ) : activeAuthTab === 'extension' ? (
                  <div style={{ textAlign: 'center', width: '100%' }}>
                    {hasNostrExtension ? (
                      <>
                        <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                          NIP-07 browser extension detected (Alby, nos2x).
                        </p>
                        <button className="btn btn-primary btn-large" onClick={handleConnectExtension} style={{ width: '100%' }}>
                          Connect Extension
                        </button>
                      </>
                    ) : (
                      <>
                        <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                          No browser extension detected. Install <a href="https://getalby.com" target="_blank" rel="noreferrer">Alby</a> or <a href="https://github.com/fiatjaf/nos2x" target="_blank" rel="noreferrer">nos2x</a>, or use <strong>Remote Signer (NIP-46)</strong> tab for mobile!
                        </p>
                      </>
                    )}
                  </div>
                ) : (
                  <div style={{ textAlign: 'left', width: '100%' }}>
                    <form onSubmit={(e) => { e.preventDefault(); handleConnectReadOnly(readOnlyInputKey); }}>
                      <input
                        type="text"
                        className="input-field"
                        placeholder="npub1... or hex public key"
                        value={readOnlyInputKey}
                        onChange={(e) => setReadOnlyInputKey(e.target.value)}
                        style={{ marginBottom: '0.5rem' }}
                        required
                      />
                      <button className="btn btn-large" type="submit" style={{ width: '100%' }}>
                        Connect Read-Only Mode
                      </button>
                    </form>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : !selectedListId ? (
        /* VIEW 2: DASHBOARD HUB (Authenticated) */
        <div className="hub-layout">
          {/* Top User Profile Header */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'var(--bg-secondary)', padding: '0.85rem 1.25rem', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)' }}>
            <div className="nostr-user-info" style={{ margin: 0 }}>
              {isSyncing && <div className="spinner" style={{ width: '14px', height: '14px', border: '2px solid var(--bg-tertiary)', borderTop: '2px solid var(--accent-color)', marginRight: '6px' }}></div>}
              {nostrUser.picture && (
                <img
                  src={nostrUser.picture}
                  alt="Avatar"
                  style={{ width: '28px', height: '28px', borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--border-color)', marginRight: '6px' }}
                />
              )}
              <span className="nostr-pubkey" style={{ fontWeight: 700, fontSize: '1.05rem' }} title={nostrUser.pubkey}>
                {nostrUser.name || `${nostrUser.pubkey.substring(0, 8)}...${nostrUser.pubkey.substring(nostrUser.pubkey.length - 4)}`}
              </span>
              {nostrUser.signerType === 'bunker' && <span className="bunker-badge">NIP-46 Bunker</span>}
              {nostrUser.readOnly && <span className="read-only-badge">Read-Only</span>}
            </div>
            <button className="btn btn-small" onClick={logoutNostr}>Disconnect</button>
          </div>

          {/* Hub Navigation Tabs */}
          <div className="hub-tabs">
            <button
              className={`hub-tab ${activeHubTab === 'my-lists' ? 'active' : ''}`}
              onClick={() => setActiveHubTab('my-lists')}
              title="My Lists"
            >
              <User size={16} /> <span className="tab-label">My Lists ({lists.length})</span>
            </button>
            <button
              className={`hub-tab ${activeHubTab === 'explore' ? 'active' : ''}`}
              onClick={() => {
                setActiveHubTab('explore');
                if (exploreLists.length === 0 && !isExploreLoading) {
                  loadExploreData(true);
                }
              }}
              title="Explore"
            >
              <Globe size={16} /> <span className="tab-label">Explore</span>
            </button>
            <button
              className={`hub-tab ${activeHubTab === 'following' ? 'active' : ''}`}
              onClick={() => setActiveHubTab('following')}
              title="Following"
            >
              <Users size={16} /> <span className="tab-label">Following ({followedPubkeys.length})</span>
            </button>
          </div>

          {activeHubTab === 'explore' ? (
            <>
              {/* Explore Feed Section */}
              <div className="hub-title-row">
                <div>
                  <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 800 }}>Explore Public Watchlists</h2>
                  <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Discover recently published media lists (<code>kind:30016</code>) from across the Nostr network in real-time.
                  </p>
                </div>
                <button
                  className="btn btn-responsive"
                  onClick={() => loadExploreData(true)}
                  disabled={isExploreLoading}
                  title="Refresh Explore Feed"
                >
                  <RefreshCw size={16} className={isExploreLoading ? 'spin' : ''} /> <span className="btn-label">{isExploreLoading ? 'Refreshing...' : 'Refresh Feed'}</span>
                </button>
              </div>

              {isExploreLoading && exploreLists.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '3rem 1rem', color: 'var(--text-secondary)' }}>
                  <RefreshCw size={28} className="spin" style={{ marginBottom: '0.5rem', color: 'var(--accent-color)' }} />
                  <div>Querying relays for public <code>kind:30016</code> watchlists...</div>
                </div>
              ) : exploreLists.length === 0 ? (
                <div className="empty-state" style={{ padding: '3rem 1.5rem', textAlign: 'center', backgroundColor: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)' }}>
                  <Globe size={36} style={{ color: 'var(--accent-color)', marginBottom: '0.75rem' }} />
                  <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem' }}>No public lists found</h3>
                  <p style={{ margin: '0 0 1.25rem 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                    No recent <code>kind:30016</code> events were returned from connected relays.
                  </p>
                  <button className="btn btn-primary" onClick={() => loadExploreData(true)}>
                    <RefreshCw size={16} /> Try Refreshing
                  </button>
                </div>
              ) : (
                <div className="following-feed">
                  <div className="lists-grid">
                    {exploreLists.map(list => {
                      const pubkey = list.id.split(':')[1] || '';
                      const profile = followedProfiles[pubkey] || exploreProfiles[pubkey];
                      const displayName = profile?.name || (pubkey ? `${pubkey.substring(0, 8)}...${pubkey.substring(pubkey.length - 4)}` : 'Anonymous');

                      return (
                        <div key={list.id} className="list-card" onClick={() => setSelectedListId(list.id)}>
                          <div className="list-card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div
                              className="profile-badge clickable"
                              style={{ fontSize: '0.8rem', cursor: 'pointer' }}
                              onClick={(e) => {
                                e.stopPropagation();
                                setAuthorProfileModal({ isOpen: true, pubkey });
                              }}
                              title={`View ${displayName}'s profile`}
                            >
                              {profile?.picture ? (
                                <img src={profile.picture} alt={displayName} className="profile-avatar" style={{ width: '22px', height: '22px' }} />
                              ) : (
                                <div className="profile-avatar-fallback" style={{ width: '22px', height: '22px', fontSize: '0.75rem' }}>{displayName.substring(0, 1).toUpperCase()}</div>
                              )}
                              <span className="profile-name" style={{ fontWeight: 600, fontSize: '0.85rem' }}>{displayName}</span>
                            </div>
                          </div>

                          <h3 className="list-card-title" style={{ marginTop: '0.5rem' }}>{renderListTitle(list)}</h3>
                          <p className="list-card-desc">{list.description || 'No description provided.'}</p>

                          <div className="list-card-footer">
                            <ListCardPosterStrip items={list.items} />
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Sentinel element for infinite scroll */}
                  <div ref={exploreObserverRef} style={{ height: '60px', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: '1.5rem' }}>
                    {isExploreLoadingMore && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
                        <RefreshCw size={18} className="spin" style={{ color: 'var(--accent-color)' }} />
                        <span>Loading older watchlists...</span>
                      </div>
                    )}
                    {!hasMoreExplore && exploreLists.length > 0 && (
                      <div style={{ color: 'var(--text-tertiary)', fontSize: '0.85rem' }}>
                        Reached end of recent public watchlists.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          ) : activeHubTab === 'my-lists' ? (
            <>
              {/* List Hub Section */}
              <div className="hub-title-row">
                <div>
                  <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 800 }}>My Media Lists</h2>
                  <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Select a list to view, edit, or add movies & TV shows.
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 }}>
                  {nostrUser && (
                    <button
                      className="btn btn-responsive"
                      onClick={() => syncFromNostr(nostrUser.pubkey)}
                      disabled={isSyncing}
                      title="Re-sync lists from Nostr relays"
                    >
                      <RefreshCw size={16} className={isSyncing ? 'spin' : ''} /> <span className="btn-label">{isSyncing ? 'Syncing...' : 'Sync Relays'}</span>
                    </button>
                  )}
                  <button
                    className="btn btn-primary btn-responsive"
                    onClick={() => setNewListModal({ isOpen: true, type: 'watched' })}
                    title="New List"
                  >
                    <Plus size={16} /> <span className="btn-label">New List</span>
                  </button>
                </div>
              </div>

              {/* Grid of List Cards */}
              <div className="lists-grid">
                {lists.map(list => (
                  <div
                    key={list.id}
                    className="list-card"
                    onClick={() => setSelectedListId(list.id)}
                  >
                    <h3 className="list-card-title" style={{ marginTop: '0.25rem' }}>{renderListTitle(list)}</h3>
                    <p className="list-card-desc">{list.description || 'No description provided.'}</p>

                    <div className="list-card-footer">
                      <ListCardPosterStrip items={list.items} />
                    </div>
                  </div>
                ))}

                <div
                  className="list-card list-card-create"
                  onClick={() => setNewListModal({ isOpen: true, type: 'watched' })}
                >
                  <Plus size={24} style={{ color: 'var(--accent-color)', marginBottom: '0.5rem' }} />
                  <div style={{ fontWeight: 700, fontSize: '1rem' }}>Create New List</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-tertiary)', marginTop: '0.25rem' }}>
                    Publish custom <code>kind:30016</code> logs
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Following Social Feed Tab */}
              <div className="hub-title-row">
                <div>
                  <h2 style={{ margin: 0, fontSize: '1.4rem', fontWeight: 800 }}>Following ({followedPubkeys.length})</h2>
                  <p style={{ margin: '0.25rem 0 0 0', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                    Discover media lists (<code>kind:30016</code>) published by your Nostr contacts (<code>kind:10016</code>).
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    className="btn btn-primary btn-responsive"
                    onClick={() => setIsFollowModalOpen(true)}
                    title="Follow Contact"
                  >
                    <UserPlus size={16} /> <span className="btn-label">Follow Contact</span>
                  </button>
                </div>
              </div>

              {followedPubkeys.length === 0 ? (
                <div className="empty-state" style={{ padding: '3rem 1.5rem', textAlign: 'center', backgroundColor: 'var(--bg-secondary)', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-color)' }}>
                  <Users size={36} style={{ color: 'var(--accent-color)', marginBottom: '0.75rem' }} />
                  <h3 style={{ margin: '0 0 0.5rem 0', fontSize: '1.1rem' }}>You aren't following anyone yet</h3>
                  <p style={{ margin: '0 0 1.25rem 0', color: 'var(--text-secondary)', fontSize: '0.9rem', maxWidth: '460px', marginLeft: 'auto', marginRight: 'auto' }}>
                    Follow Nostr profiles by entering their <code>npub</code> key to view their public watchlists and watched review logs.
                  </p>
                  <button className="btn btn-primary" onClick={() => setIsFollowModalOpen(true)}>
                    <UserPlus size={16} /> Follow a Nostr Contact
                  </button>
                </div>
              ) : (
                <div className="following-feed">
                  {followedPubkeys.map(pk => {
                    const profile = followedProfiles[pk];
                    const userLists = followedListsMap[pk] || [];
                    const displayName = profile?.name || `${pk.substring(0, 8)}...${pk.substring(pk.length - 4)}`;
                    const isExpanded = Boolean(expandedFollowingUsers[pk]);

                    return (
                      <div key={pk} className="following-user-section">
                        <div
                          className={`following-user-header clickable ${isExpanded ? 'expanded' : ''}`}
                          onClick={() => toggleFollowedUserExpand(pk)}
                          title={isExpanded ? "Click to collapse watchlists" : "Click to expand watchlists"}
                        >
                          <div className="profile-badge">
                            {profile?.picture ? (
                              <img src={profile.picture} alt={displayName} className="profile-avatar" />
                            ) : (
                              <div className="profile-avatar-fallback">{displayName.substring(0, 1).toUpperCase()}</div>
                            )}
                            <div>
                              <div className="profile-name">{displayName}</div>
                              <div className="profile-npub" title={pk}>npub: {pk.substring(0, 10)}...{pk.substring(pk.length - 6)}</div>
                            </div>
                          </div>

                          <button
                            className="btn btn-action-icon btn-delete btn-responsive"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUnfollowUser(pk);
                            }}
                            title="Unfollow user"
                          >
                            <UserMinus size={16} /> <span className="btn-label">Unfollow</span>
                          </button>
                        </div>

                        {isExpanded && (
                          <div style={{ marginTop: '0.75rem' }}>
                            {userLists.length === 0 ? (
                              <div style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', padding: '0.5rem 0' }}>
                                No public <code>kind:30016</code> lists found for this profile on connected relays.
                              </div>
                            ) : (
                              <div className="lists-grid">
                                {userLists.map(list => (
                                  <div
                                    key={list.id}
                                    className="list-card"
                                    onClick={() => setSelectedListId(list.id)}
                                  >
                                    <h3 className="list-card-title" style={{ marginTop: '0.25rem' }}>{renderListTitle(list)}</h3>
                                    <p className="list-card-desc">{list.description || 'No description provided.'}</p>

                                    <div className="list-card-footer">
                                      <ListCardPosterStrip items={list.items} />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}

          {/* Nostr Relay Status Console Footer */}
          {Object.keys(relayStatuses).length > 0 && (
            <footer style={{ marginTop: '2rem', display: 'flex', justifyContent: 'center' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                <span>Relays:</span>
                {Object.entries(relayStatuses).map(([url, connected]) => (
                  <span key={url} style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
                    <span style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: connected ? '#10b981' : '#ef4444' }}></span>
                    {url.replace('wss://', '')}
                  </span>
                ))}
              </div>
            </footer>
          )}
        </div>
      ) : (
        /* PAGE 2: SINGLE LIST FOCUSED WORKSPACE */
        <div className="workspace-container">
          <div className="workspace-nav-bar">
            <button className="btn" onClick={() => setSelectedListId(null)}>
              <ArrowLeft size={16} /> Back to My Lists
            </button>
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '8px',
                padding: '0.35rem 0.75rem',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-color)',
                backgroundColor: 'var(--bg-primary)',
                fontSize: '0.85rem'
              }}
            >
              {nostrUser?.picture && (
                <img
                  src={nostrUser.picture}
                  alt="Avatar"
                  style={{ width: '20px', height: '20px', borderRadius: '50%', objectFit: 'cover' }}
                />
              )}
              <span style={{ fontWeight: 600 }}>
                {nostrUser?.name || (nostrUser ? `${nostrUser.pubkey.substring(0, 8)}...` : '')}
              </span>
              <button
                className="btn btn-small"
                onClick={logoutNostr}
                style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem', marginLeft: '4px' }}
              >
                Disconnect
              </button>
            </div>
          </div>

          {/* List Workspace Header */}
          {currentList && (
            <div className="workspace-header-card">
              {isSocialList && socialProfile && (
                <div
                  className="social-author-banner clickable"
                  onClick={() => socialProfile?.pubkey && setAuthorProfileModal({ isOpen: true, pubkey: socialProfile.pubkey })}
                  title={`View ${socialProfile.name}'s profile`}
                >
                  <Globe size={16} color="var(--accent-color)" />
                  <span>Viewing <strong>{socialProfile.name}</strong>'s public list (Read-Only)</span>
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
                    <h1 className="workspace-title">{renderListTitle(currentList)}</h1>

                    {!isSocialList && (!nostrUser || !nostrUser.readOnly) && (
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', marginLeft: '4px' }}>
                        <button
                          className="btn btn-action-icon btn-small"
                          onClick={() => openEditListModal(currentList)}
                          title="Edit list title and description"
                          style={{ padding: '3px 8px', fontSize: '0.75rem' }}
                        >
                          <Pencil size={13} /> <span className="btn-label">Edit</span>
                        </button>
                        <button
                          className="btn btn-action-icon btn-delete btn-small"
                          onClick={() => confirmDeleteList(currentList)}
                          title="Delete this list"
                          style={{ padding: '3px 8px', fontSize: '0.75rem' }}
                        >
                          <Trash2 size={13} /> <span className="btn-label">Delete</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <p className="workspace-desc">{currentList.description || 'No description provided.'}</p>
                </div>
                <div className="workspace-stats" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '8px' }}>
                  {!isSocialList && (!nostrUser || !nostrUser.readOnly) && (
                    <button className="btn btn-primary btn-responsive" onClick={() => setIsSearchDrawerOpen(true)} title="Find & Add">
                      <Plus size={16} /> <span className="btn-label">Find & Add</span>
                    </button>
                  )}
                  <span className="workspace-item-count">{currentList.items.length} Items</span>
                </div>
              </div>
            </div>
          )}

          {/* Media Items List */}
          <div className="workspace-content">
            {!currentList || currentList.items.length === 0 ? (
              <div className="empty-state">
                <Film size={48} className="empty-state-icon" />
                <h3 className="empty-state-title">This list is currently empty</h3>
                {!isSocialList && (!nostrUser || !nostrUser.readOnly) ? (
                  <>
                    <p className="empty-state-text">
                      Use the <strong>Find & Add</strong> button to find movies or TV shows on TheTVDB and add them to <strong>{currentList ? renderListTitle(currentList) : 'this list'}</strong>.
                    </p>
                    <button className="btn btn-primary btn-responsive" onClick={() => setIsSearchDrawerOpen(true)} title="Find & Add">
                      <Plus size={16} /> <span className="btn-label">Find & Add</span>
                    </button>
                  </>
                ) : (
                  <p className="empty-state-text">
                    No items have been added to this list yet.
                  </p>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                {currentList.items.map(item => (
                  <div key={item.id} className="media-card" style={{ display: 'flex', alignItems: 'center', padding: '0.85rem 1rem' }}>
                    <div
                      className="poster-container"
                      style={{ cursor: 'pointer' }}
                      onClick={() => openDetailsModal(item)}
                    >
                      {item.poster ? (
                        <img src={item.poster} alt={item.title} className="poster-img" />
                      ) : (
                        <div className="media-placeholder-icon">
                          {item.type === 'movie' ? <Film size={24} /> : <Tv size={24} />}
                        </div>
                      )}
                    </div>

                    <div className="media-info" style={{ flexGrow: 1, paddingLeft: '1rem' }}>
                      <div className="media-header">
                        <span
                          className="media-title clickable"
                          onClick={() => openDetailsModal(item)}
                          style={{ fontSize: '1.1rem' }}
                        >
                          {item.title}
                        </span>
                        {' '}<span className="media-year">({item.year})</span>
                      </div>

                      {renderDirectorCreator(item)}

                      {currentList.type === 'watched' && (item.userRating !== undefined || item.watchedDate) && (
                        <div className="user-log-details" style={{ marginTop: '4px', display: 'flex', alignItems: 'center', gap: '12px' }}>
                          {item.userRating !== undefined && (
                            <div style={{ fontSize: '1.3rem', lineHeight: '1' }} title={`Rated ${item.userRating}/10`}>
                              {['🤮', '🤢', '🤨', '😐', '🙂', '😊', '😀', '😍', '🤩', '🤯'][Math.min(Math.max(Math.round(item.userRating) - 1, 0), 9)]}
                            </div>
                          )}
                          {item.watchedDate && (
                            <span className="media-year" style={{ fontSize: '0.8rem' }}>
                              Watched {item.watchedDate.split('-').length === 3
                                ? `${getMonthName(item.watchedDate.split('-')[1])} ${parseInt(item.watchedDate.split('-')[2], 10)}, ${item.watchedDate.split('-')[0]}`
                                : item.watchedDate.split('-').length === 2
                                ? `${getMonthName(item.watchedDate.split('-')[1])} ${item.watchedDate.split('-')[0]}`
                                : item.watchedDate
                              }
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="media-actions" style={{ flexShrink: 0, display: 'flex', flexDirection: currentList.type === 'watched' ? 'column' : 'row', alignItems: 'center', gap: '4px' }}>
                      {!isSocialList && currentList.type === 'watchlist' ? (
                        <>
                          <button
                            className="btn btn-primary btn-responsive"
                            onClick={() => openLogWatchedModal(item, 'watchlist', currentList.id)}
                            title="Mark as watched"
                          >
                            <Check size={14} /> <span className="btn-label">Watched</span>
                          </button>
                          <button
                            className="btn btn-action-icon btn-delete"
                            onClick={() => removeFromWatchlist(item.id, currentList.id)}
                            title="Remove from list"
                          >
                            <Trash2 size={14} />
                          </button>
                        </>
                      ) : !isSocialList && currentList.type === 'watched' ? (
                        <>
                          <button
                            className="btn btn-action-icon btn-delete"
                            onClick={() => removeFromWatched(item.id, currentList.id)}
                            title="Remove from watched log"
                          >
                            <Trash2 size={14} />
                          </button>
                          <button
                            className="btn btn-action-icon"
                            onClick={() => openLogWatchedModal(item, 'edit', currentList.id)}
                            title="Edit details"
                          >
                            <Pencil size={14} />
                          </button>
                          {renderWatchlistRibbon(item)}
                        </>
                      ) : (
                        <>
                          {renderWatchlistRibbon(item)}
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Search Modal Popup */}
          {isSearchDrawerOpen && (
            <div className="search-drawer-overlay" onClick={() => setIsSearchDrawerOpen(false)}>
              <div className="search-drawer" onClick={(e) => e.stopPropagation()}>
                <div className="search-drawer-header">
                  <h3 className="modal-title" style={{ margin: 0 }}>Find & Add Media</h3>
                  <button className="btn btn-action-icon" onClick={() => setIsSearchDrawerOpen(false)} title="Close">
                    <X size={16} />
                  </button>
                </div>

                <div className="search-drawer-body">
                  <div className="search-input-box">
                    <Search size={15} className="search-input-icon" />
                    <input
                      type="text"
                      className="input-field search-input"
                      placeholder="Search movies or TV series on TheTVDB..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      autoFocus
                    />
                    {searchQuery && (
                      <button className="btn btn-action-icon search-clear-btn" onClick={clearSearch} title="Clear search">
                        <X size={14} />
                      </button>
                    )}
                  </div>

                  <div className="search-results-list">
                    {isLoading ? (
                      <div className="loading-container">
                        <div className="spinner"></div>
                        <p style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Searching TheTVDB...</p>
                      </div>
                    ) : error ? (
                      <div className="error-card" style={{ padding: '1rem', fontSize: '0.85rem' }}>{error}</div>
                    ) : searchResults.length > 0 ? (
                      searchResults.map(item => {
                        const alreadyInList = currentList?.items.some(x => x.id === item.id);
                        return (
                          <div key={item.id} className="media-card" style={{ display: 'flex', alignItems: 'center', padding: '0.5rem 0.75rem' }}>
                            <div className="poster-container" style={{ width: '48px', height: '68px', cursor: 'pointer' }} onClick={() => openDetailsModal(item)}>
                              {item.poster ? (
                                <img src={item.poster} alt={item.title} className="poster-img" />
                              ) : (
                                <div className="media-placeholder-icon">
                                  {item.type === 'movie' ? <Film size={16} /> : <Tv size={16} />}
                                </div>
                              )}
                            </div>

                            <div className="media-info" style={{ flexGrow: 1, paddingLeft: '0.75rem' }}>
                              <div className="media-header" style={{ fontSize: '0.95rem' }}>
                                <span className="media-title clickable" onClick={() => openDetailsModal(item)}>
                                  {item.title}
                                </span>
                                {' '}<span className="media-year">({item.year})</span>
                              </div>
                              {renderDirectorCreator(item)}
                            </div>

                            <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
                              {renderWatchlistRibbon(item)}
                              {alreadyInList ? (
                                <button className="btn btn-success" disabled style={{ padding: '4px 8px', fontSize: '0.8rem' }}>
                                  <Check size={14} /> Added
                                </button>
                              ) : (
                                <button
                                  className="btn btn-primary"
                                  onClick={() => {
                                    if (currentList) {
                                      if (currentList.type === 'watchlist') {
                                        addToWatchlist(item, currentList.id);
                                      } else {
                                        openLogWatchedModal(item, 'search', currentList.id);
                                      }
                                    }
                                    setIsSearchDrawerOpen(false);
                                    clearSearch();
                                  }}
                                  style={{ padding: '4px 8px', fontSize: '0.8rem' }}
                                >
                                  <Plus size={14} /> Add
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    ) : searchQuery.trim() ? (
                      <div className="empty-state" style={{ padding: '2rem 0' }}>
                        <p className="empty-state-title">No matches found</p>
                        <p className="empty-state-text">Try searching for a different title on TheTVDB.</p>
                      </div>
                    ) : (
                      <div style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem 1rem', fontSize: '0.9rem' }}>
                        Type a title above to search for movies or series to add to <strong>{currentList ? renderListTitle(currentList) : 'this list'}</strong>.
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Modal Dialog for logging watched details */}
      {logModal.isOpen && logModal.item && (
        <div className="modal-overlay" onClick={() => setLogModal(prev => ({ ...prev, isOpen: false, item: null }))}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              <h3 className="modal-title" style={{ margin: 0 }}>
                {logModal.sourceList === 'edit' ? 'Edit Watched Details' : 'Log as Watched'}
              </h3>
              <button
                className="btn btn-action-icon"
                onClick={() => setLogModal(prev => ({ ...prev, isOpen: false, item: null }))}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', margin: '1rem 0' }}>
              {logModal.item.poster && (
                <img src={logModal.item.poster} alt={logModal.item.title} style={{ width: '40px', height: '60px', objectFit: 'cover', borderRadius: '4px' }} />
              )}
              <div>
                <h4 style={{ margin: 0, fontSize: '1rem' }}>{logModal.item.title}</h4>
                <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{logModal.item.year}</div>
              </div>
            </div>

            <div className="modal-field">
              <label className="modal-label">Date Watched</label>
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <select
                  className="input-field select-field"
                  value={logModal.year}
                  onChange={(e) => setLogModal(prev => ({ ...prev, year: e.target.value, month: '', day: '' }))}
                  style={{ flex: '1.2 1 0px', minWidth: '90px' }}
                >
                  <option value="">Year...</option>
                  {getYearOptions(logModal.year).map(y => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>

                <select
                  className="input-field select-field"
                  value={logModal.month}
                  disabled={!logModal.year}
                  onChange={(e) => setLogModal(prev => ({ ...prev, month: e.target.value, day: '' }))}
                  style={{ flex: '1.5 1 0px', minWidth: '100px' }}
                >
                  <option value="">Month...</option>
                  <option value="01">Jan (01)</option>
                  <option value="02">Feb (02)</option>
                  <option value="03">Mar (03)</option>
                  <option value="04">Apr (04)</option>
                  <option value="05">May (05)</option>
                  <option value="06">Jun (06)</option>
                  <option value="07">Jul (07)</option>
                  <option value="08">Aug (08)</option>
                  <option value="09">Sep (09)</option>
                  <option value="10">Oct (10)</option>
                  <option value="11">Nov (11)</option>
                  <option value="12">Dec (12)</option>
                </select>

                <select
                  className="input-field select-field"
                  value={logModal.day}
                  disabled={!logModal.year || !logModal.month}
                  onChange={(e) => setLogModal(prev => ({ ...prev, day: e.target.value }))}
                  style={{ flex: '0.8 1 0px', minWidth: '80px' }}
                >
                  <option value="">Day...</option>
                  {getDayOptions(logModal.year, logModal.month).map(d => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>

                <button
                  type="button"
                  className="btn"
                  style={{ whiteSpace: 'nowrap' }}
                  onClick={setTodayDate}
                >
                  Today
                </button>
              </div>
            </div>

            <div className="modal-field">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <label className="modal-label">Your Rating</label>
                {logModal.rating && (
                  <span style={{ fontSize: '0.8rem', fontWeight: 650, color: 'var(--accent-color)' }}>
                    {logModal.rating}/10 - {
                      ['🤮 Vomiting', '🤢 Nauseous', '🤨 Skeptical', '😐 Neutral', '🙂 Slight Smile', '😊 Warm Smile', '😀 Grinning', '😍 Heart Eyes', '🤩 Star-struck', '🤯 Mind Blown'][parseInt(logModal.rating, 10) - 1]
                    }
                  </span>
                )}
              </div>
              <div className="emoji-rating-picker" style={{ display: 'flex', justifyContent: 'space-between', gap: '4px', margin: '4px 0', padding: '8px', backgroundColor: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-color)' }}>
                {['🤮', '🤢', '🤨', '😐', '🙂', '😊', '😀', '😍', '🤩', '🤯'].map((emoji, index) => {
                  const value = (index + 1).toString();
                  const isActive = logModal.rating === value;
                  const isOptional = ['2', '4', '6', '7', '9'].includes(value);
                  return (
                    <button
                      key={value}
                      type="button"
                      className={`emoji-picker-btn ${isActive ? 'active' : ''} ${isOptional ? 'optional-rating' : ''}`}
                      onClick={() => setLogModal(prev => ({ ...prev, rating: prev.rating === value ? '' : value }))}
                      title={`${index + 1}/10`}
                      style={{
                        background: 'none',
                        border: 'none',
                        fontSize: '1.6rem',
                        cursor: 'pointer',
                        padding: '4px',
                        borderRadius: 'var(--radius-sm)',
                        transition: 'transform var(--transition-fast), opacity var(--transition-fast)',
                        opacity: logModal.rating ? (isActive ? '1' : '0.35') : '0.8',
                        transform: isActive ? 'scale(1.25)' : 'scale(1)'
                      }}
                    >
                      {emoji}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="modal-actions-bar">
              <button
                className="btn"
                onClick={() => setLogModal(prev => ({ ...prev, isOpen: false, item: null }))}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={saveWatchedDetails}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Dialog for viewing TVDB details */}
      {detailsModal.isOpen && detailsModal.item && (
        <div className="modal-overlay" onClick={closeDetailsModal}>
          <div className="modal-content modal-content-lg" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              <h3 className="modal-title" style={{ margin: 0 }}>
                {detailsModal.item.type === 'tv' ? 'TV Show Details' : 'Movie Details'}
              </h3>
              <button
                className="btn btn-action-icon"
                onClick={closeDetailsModal}
              >
                <X size={16} />
              </button>
            </div>

            {detailsModal.isLoading ? (
              <div className="loading-container" style={{ padding: '3rem 0' }}>
                <div className="spinner"></div>
                <p style={{ marginTop: '0.5rem', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>
                  Fetching detailed information from TheTVDB...
                </p>
              </div>
            ) : detailsModal.error ? (
              <div className="error-card" style={{ margin: '1.5rem 0' }}>
                <p>{detailsModal.error}</p>
                <button className="btn" onClick={() => openDetailsModal(detailsModal.item!)}>Retry</button>
              </div>
            ) : detailsModal.extendedInfo ? (
              (() => {
                const info = detailsModal.extendedInfo;
                const item = detailsModal.item;
                const inWatched = watchedList.some(x => x.id === item.id);
                const hasValidPoster = item.poster && !item.poster.includes('missing/series.jpg') && !item.poster.includes('missing/movie.jpg');

                const overviewText = info.overview || item.overview || 'No description available on TheTVDB.';
                const statusStr = info.status?.name || info.status || 'N/A';
                const firstAiredStr = info.firstAired || info.releaseDate || item.year || 'N/A';
                const runtimeStr = info.averageRuntime ? `${info.averageRuntime} mins` : (info.runtime ? `${info.runtime} mins` : 'N/A');

                let networkStudio = 'N/A';
                if (item.type === 'tv' && info.networks && info.networks.length > 0) {
                  networkStudio = info.networks[0].name;
                } else if (item.type === 'movie' && info.studios && info.studios.length > 0) {
                  networkStudio = info.studios[0].name;
                } else if (item.creator) {
                  networkStudio = item.creator;
                }

                return (
                  <div className="details-grid" style={{ padding: '1rem 0' }}>
                    <div className="details-poster-col">
                      {hasValidPoster ? (
                        <img src={item.poster} alt={item.title} className="details-poster-img" />
                      ) : (
                        <div className="details-poster-placeholder">
                          {item.type === 'movie' ? <Film size={48} /> : <Tv size={48} />}
                        </div>
                      )}
                    </div>

                    <div className="details-info-col">
                      <h2 className="details-title">{info.name || item.title}</h2>

                      <div style={{ marginBottom: '0.75rem' }}>
                        {item.genres && item.genres.length > 0 && (
                          <div className="details-genres" style={{ marginBottom: '0.5rem' }}>
                            {item.genres.map((g: any, idx: number) => {
                              const genreStr = typeof g === 'string' ? g : (g?.name || String(g));
                              return <span key={genreStr || idx} className="badge badge-subtle">{genreStr}</span>;
                            })}
                          </div>
                        )}

                        {item.type === 'movie' && item.director && (
                          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                            Directed by: <strong style={{ color: 'var(--text-primary)' }}>{item.director}</strong>
                          </div>
                        )}
                        {item.type === 'tv' && (info.showrunner || item.creator) && (
                          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                            Showrunner / Creator: <strong style={{ color: 'var(--text-primary)' }}>{info.showrunner || item.creator}</strong>
                          </div>
                        )}
                      </div>

                      <div className="details-overview">
                        {overviewText}
                      </div>

                      <div className="details-info-table">
                        <span className="details-info-label">Status</span>
                        <span className="details-info-value">{statusStr}</span>

                        <span className="details-info-label">{item.type === 'tv' ? 'First Aired' : 'Released'}</span>
                        <span className="details-info-value">{firstAiredStr}</span>

                        <span className="details-info-label">{item.type === 'tv' ? 'Avg Runtime' : 'Runtime'}</span>
                        <span className="details-info-value">{runtimeStr}</span>

                        <span className="details-info-label">{item.type === 'tv' ? 'Network' : 'Studio'}</span>
                        <span className="details-info-value">{networkStudio}</span>
                      </div>

                      <div style={{ marginTop: 'auto', paddingTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', flexWrap: 'wrap', borderTop: '1px solid var(--border-color)' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {renderWatchlistRibbon(item)}

                          {inWatched ? (
                            <button className="btn btn-success" disabled>
                              <Check size={14} /> Watched
                            </button>
                          ) : (
                            <button
                              className="btn btn-primary"
                              onClick={() => {
                                closeDetailsModal();
                                openLogWatchedModal(item, 'search');
                              }}
                            >
                              <Check size={14} /> Mark Watched
                            </button>
                          )}
                        </div>

                        {info.slug && (
                          <a
                            href={`https://thetvdb.com/${item.type === 'tv' ? 'series' : 'movies'}/${info.slug}`}
                            target="_blank"
                            rel="noreferrer"
                            className="btn btn-subtle"
                            style={{ fontSize: '0.8rem', padding: '4px 8px' }}
                          >
                            View on TVDB <ExternalLink size={12} style={{ marginLeft: '4px' }} />
                          </a>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()
            ) : null}
          </div>
        </div>
      )}

      {/* Modal Dialog for creating a new custom list */}
      {newListModal.isOpen && (
        <div className="modal-overlay" onClick={() => setNewListModal({ isOpen: false, type: 'watched' })}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              <h3 className="modal-title" style={{ margin: 0 }}>
                Create New List
              </h3>
              <button
                className="btn btn-action-icon"
                onClick={() => setNewListModal({ isOpen: false, type: 'watched' })}
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={createNewList} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginTop: '1.25rem' }}>
              <div className="modal-field">
                <label className="modal-label">List Type</label>
                <div style={{ display: 'flex', gap: '6px', padding: '4px', backgroundColor: 'var(--bg-secondary)', borderRadius: 'var(--radius-sm)', border: '1px solid #eaeaea' }}>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setNewListModal(prev => ({ ...prev, type: 'watched' }))}
                    style={{
                      flex: 1,
                      border: 'none',
                      backgroundColor: newListModal.type === 'watched' ? 'var(--accent-color)' : 'transparent',
                      color: newListModal.type === 'watched' ? '#ffffff' : 'var(--text-secondary)',
                      fontWeight: newListModal.type === 'watched' ? 700 : 500,
                      boxShadow: newListModal.type === 'watched' ? 'var(--shadow-sm)' : 'none',
                      transition: 'all var(--transition-fast)'
                    }}
                  >
                    Watched
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setNewListModal(prev => ({ ...prev, type: 'watchlist' }))}
                    style={{
                      flex: 1,
                      border: 'none',
                      backgroundColor: newListModal.type === 'watchlist' ? 'var(--accent-color)' : 'transparent',
                      color: newListModal.type === 'watchlist' ? '#ffffff' : 'var(--text-secondary)',
                      fontWeight: newListModal.type === 'watchlist' ? 700 : 500,
                      boxShadow: newListModal.type === 'watchlist' ? 'var(--shadow-sm)' : 'none',
                      transition: 'all var(--transition-fast)'
                    }}
                  >
                    To Watch
                  </button>
                </div>
              </div>

              <div className="modal-field">
                <label className="modal-label">List Title *</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder={newListModal.type === 'watched' ? "e.g., Summer 2026 Horror Movies" : "e.g., Sci-Fi Favorites To Watch"}
                  value={newListForm.title}
                  onChange={(e) => setNewListForm(prev => ({ ...prev, title: e.target.value }))}
                  required
                  autoFocus
                />
              </div>

              <div className="modal-field">
                <label className="modal-label">Description (Optional)</label>
                <textarea
                  className="input-field"
                  placeholder="Provide a brief description for this list..."
                  rows={3}
                  value={newListForm.description}
                  onChange={(e) => setNewListForm(prev => ({ ...prev, description: e.target.value }))}
                  style={{ resize: 'vertical' }}
                />
              </div>

              <div className="modal-actions-bar">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setNewListModal({ isOpen: false, type: 'watched' })}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                >
                  Create & Publish List
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Dialog for editing existing list */}
      {editListModal.isOpen && editListModal.list && (
        <div className="modal-overlay" onClick={() => setEditListModal({ isOpen: false, list: null })}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              <h3 className="modal-title" style={{ margin: 0 }}>Edit List Details</h3>
              <button className="btn btn-action-icon" onClick={() => setEditListModal({ isOpen: false, list: null })}>
                <X size={16} />
              </button>
            </div>

            <form onSubmit={saveEditList} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', marginTop: '1.25rem' }}>
              <div className="modal-field">
                <label className="modal-label">List Title *</label>
                <input
                  type="text"
                  className="input-field"
                  value={editListForm.title}
                  onChange={(e) => setEditListForm(prev => ({ ...prev, title: e.target.value }))}
                  required
                  autoFocus
                />
              </div>

              <div className="modal-field">
                <label className="modal-label">Description (Optional)</label>
                <textarea
                  className="input-field"
                  placeholder="Provide a brief description for this list..."
                  rows={3}
                  value={editListForm.description}
                  onChange={(e) => setEditListForm(prev => ({ ...prev, description: e.target.value }))}
                  style={{ resize: 'vertical' }}
                />
              </div>

              <div className="modal-actions-bar">
                <button
                  type="button"
                  className="btn"
                  onClick={() => setEditListModal({ isOpen: false, list: null })}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                >
                  <Check size={16} /> Save & Publish
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal Dialog for deleting list confirmation */}
      {deleteListModal.isOpen && deleteListModal.list && (
        <div className="modal-overlay" onClick={() => setDeleteListModal({ isOpen: false, list: null })}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '440px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              <h3 className="modal-title" style={{ margin: 0, color: '#ef4444', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <Trash2 size={18} /> Delete List
              </h3>
              <button className="btn btn-action-icon" onClick={() => setDeleteListModal({ isOpen: false, list: null })}>
                <X size={16} />
              </button>
            </div>

            <div style={{ padding: '1.25rem 0 0.5rem 0' }}>
              <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.95rem', color: 'var(--text-primary)', lineHeight: '1.5' }}>
                Are you sure you want to delete <strong>"{deleteListModal.list.title}"</strong>?
              </p>
              <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                This action will permanently remove the list and publish a deletion request to Nostr relays. This cannot be undone.
              </p>
            </div>

            <div className="modal-actions-bar" style={{ marginTop: '1.25rem' }}>
              <button
                type="button"
                className="btn"
                onClick={() => setDeleteListModal({ isOpen: false, list: null })}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                style={{ backgroundColor: '#ef4444', borderColor: '#ef4444', color: '#ffffff' }}
                onClick={executeDeleteList}
              >
                <Trash2 size={16} /> Delete Permanently
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Dialog for Following a new Contact (kind:10016) */}
      {isFollowModalOpen && (
        <div className="modal-overlay" onClick={() => setIsFollowModalOpen(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
              <h3 className="modal-title" style={{ margin: 0 }}>Follow Nostr Contact</h3>
              <button className="btn btn-action-icon" onClick={() => setIsFollowModalOpen(false)}>
                <X size={16} />
              </button>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); handleFollowUser(followInputKey); }} style={{ marginTop: '1rem' }}>
              <div className="modal-field">
                <label className="modal-label">Nostr Public Key (npub1... or 64-char Hex) *</label>
                <input
                  type="text"
                  className="input-field"
                  placeholder="npub1..."
                  value={followInputKey}
                  onChange={(e) => setFollowInputKey(e.target.value)}
                  required
                  autoFocus
                />
                {followError && (
                  <span style={{ fontSize: '0.8rem', color: '#ef4444', marginTop: '0.4rem', display: 'block' }}>
                    {followError}
                  </span>
                )}
              </div>

              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: '0.5rem 0 1rem 0' }}>
                Following a profile adds their <code>p</code> tag to your <code>kind:10016</code> media follow list on Nostr, allowing you to discover their <code>kind:30016</code> logs.
              </p>

              <div className="modal-actions-bar">
                <button type="button" className="btn" onClick={() => setIsFollowModalOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary">
                  <UserPlus size={16} /> Follow Profile
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Author Profile Summary Modal */}
      {authorProfileModal.isOpen && authorProfileModal.pubkey && (() => {
        const pk = authorProfileModal.pubkey;
        const profile = followedProfiles[pk] || exploreProfiles[pk];
        const displayName = profile?.name || `${pk.substring(0, 8)}...${pk.substring(pk.length - 4)}`;
        const isFollowing = followedPubkeys.includes(pk);
        const isSelf = nostrUser?.pubkey === pk;
        const userLists = followedListsMap[pk] || exploreLists.filter(l => l.id.startsWith(`social:${pk}:`));

        return (
          <div className="modal-overlay" onClick={() => setAuthorProfileModal({ isOpen: false, pubkey: null })}>
            <div className="modal-content" style={{ maxWidth: '480px', width: '90%' }} onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
                <h3 className="modal-title" style={{ margin: 0 }}>Author Profile</h3>
                <button className="btn btn-action-icon" onClick={() => setAuthorProfileModal({ isOpen: false, pubkey: null })}>
                  <X size={16} />
                </button>
              </div>

              <div style={{ padding: '1.25rem 0 0.5rem 0' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '1.25rem' }}>
                  {profile?.picture ? (
                    <img
                      src={profile.picture}
                      alt={displayName}
                      style={{ width: '52px', height: '52px', borderRadius: '50%', objectFit: 'cover', border: '2px solid var(--border-color)' }}
                    />
                  ) : (
                    <div
                      style={{
                        width: '52px',
                        height: '52px',
                        borderRadius: '50%',
                        backgroundColor: 'var(--accent-color)',
                        color: '#fff',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '1.4rem',
                        fontWeight: 700
                      }}
                    >
                      {displayName.substring(0, 1).toUpperCase()}
                    </div>
                  )}

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h4 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 700, wordBreak: 'break-word' }}>{displayName}</h4>
                    <div
                      style={{
                        fontSize: '0.8rem',
                        color: 'var(--text-tertiary)',
                        marginTop: '0.2rem',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                      }}
                    >
                      <span style={{ fontFamily: 'monospace' }}>npub: {pk.substring(0, 10)}...{pk.substring(pk.length - 6)}</span>
                    </div>
                  </div>
                </div>

                {!isSelf && (
                  <div style={{ marginBottom: '1.25rem' }}>
                    {isFollowing ? (
                      <button
                        className="btn btn-action-icon btn-delete"
                        style={{ width: '100%', justifyContent: 'center', padding: '0.6rem 1rem' }}
                        onClick={() => {
                          handleUnfollowUser(pk);
                        }}
                      >
                        <UserMinus size={16} /> Unfollow Contact
                      </button>
                    ) : (
                      <button
                        className="btn btn-primary"
                        style={{ width: '100%', justifyContent: 'center', padding: '0.6rem 1rem' }}
                        onClick={() => {
                          handleFollowUser(pk);
                        }}
                      >
                        <UserPlus size={16} /> Follow Contact
                      </button>
                    )}
                  </div>
                )}

                <div>
                  <h5 style={{ margin: '0 0 0.5rem 0', fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-secondary)' }}>
                    Public Watchlists ({userLists.length})
                  </h5>

                  {userLists.length === 0 ? (
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                      No public watchlists loaded for this profile yet.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '200px', overflowY: 'auto' }}>
                      {userLists.map(list => (
                        <div
                          key={list.id}
                          style={{
                            padding: '0.6rem 0.8rem',
                            borderRadius: 'var(--radius-md)',
                            backgroundColor: 'var(--bg-secondary)',
                            border: '1px solid var(--border-color)',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            cursor: 'pointer'
                          }}
                          onClick={() => {
                            setAuthorProfileModal({ isOpen: false, pubkey: null });
                            setSelectedListId(list.id);
                          }}
                        >
                          <div>
                            <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{renderListTitle(list)}</div>
                            <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                              {list.items.length} item{list.items.length === 1 ? '' : 's'}
                            </div>
                          </div>
                          <span style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--accent-color)' }}>Open →</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

export default App;
