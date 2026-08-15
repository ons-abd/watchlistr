# Watchlistr

A modern, decentralized movie & TV show tracking application built on **Nostr** (`kind:30016`). Create custom watchlists, log watched titles with ratings and dates, and explore your followed contacts' public lists.

---

## Features

- **Decentralized Storage**: Save and sync lists via Nostr relays using `kind:30016` parameterized replaceable events.
- **Unified Authentication**:
  - **NIP-07** browser extension support (Alby, nos2x, etc.)
  - **NIP-46** Nostr Connect / Bunker support (NsecBunker)
  - **Read-Only** pubkey browsing mode
- **Rich Media Metadata**: Integrated with **TheTVDB API v4** for posters, release years, directors, creators, and episode details.
- **Dual List Types**:
  - **To Watch**: Keep track of movies and series you plan to watch.
  - **Watched Logs**: Log watched dates, personal ratings, and notes.
- **Social Discovery**: Follow contacts and inspect their public watchlists.
- **Decoupled Architecture**: Clean separation between static React frontend and standalone Node.js TVDB API proxy server.

---

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Lucide React
- **Nostr**: `nostr-tools`, NIP-07, NIP-46
- **Backend API Proxy**: Node.js 20 (native `http` & `fetch`)
- **Deployment**: Docker, Caddy

---

## Local Development

### 1. Prerequisites
- **Node.js**: v18 or higher
- **TheTVDB API Key**: Free key from [TheTVDB API](https://thetvdb.com/api-information)

### 2. Environment Setup
Copy the example environment file and add your TVDB API key:

```bash
cp .env.example .env
```

Edit `.env`:
```env
TTVDB_API_KEY=your_tvdb_api_key_here
# PORT=3000 (Optional, defaults to 3000)
```

### 3. Install Dependencies
```bash
npm install
```

### 4. Run Development Servers
Start both the TVDB API backend server and Vite frontend concurrently:

```bash
npm run dev:all
```

- **Frontend**: `https://localhost:5173`
- **Backend API**: `http://localhost:3000`

---

## Production Deployment

Watchlistr uses a high-performance decoupled deployment architecture:

### 1. Build Static Frontend
Compile the React frontend into static production files:

```bash
npm run build
```
This generates optimized static files in the `dist/` directory.

### 2. Run Backend Container
Run the backend API proxy server container using Docker Compose:

```bash
docker compose up -d
```

### 3. Serve via Caddy
Mount `dist/` into your Caddy server and use the following reverse proxy block:

```caddy
watchlistr.example.com {
    encode zstd gzip
    root * /srv/watchlistr

    handle /api/* {
        reverse_proxy ttvdb-proxy:3000
    }

    handle {
        try_files {path} /index.html
        file_server
    }
}
```
