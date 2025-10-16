# GIS Viewer Prototype

A simple prototype with an Express backend that synthesizes GeoJSON features and a React + Leaflet frontend that queries and visualizes them.

## Structure

- `server/` Express API (`/api/query`)
- `client/` React + Vite + Leaflet UI

## Prerequisites

- Node.js 18+

## Setup & Run

In two terminals:

1) Server

```
cd server
npm install
npm start
```

Server runs on `http://localhost:4000`.

2) Client

```
cd client
npm install
npm run dev
```

Client runs on `http://localhost:5173`.

By default, the client calls the server at `http://localhost:4000`. To change, set `VITE_API_BASE` in an `.env` file inside `client/`:

```
VITE_API_BASE=http://localhost:4000
```

## Usage

- Open the client in the browser.
- Enter a query like "show crop areas" and submit.
- The map will display synthetic polygons with category-based colors.
- Hover to highlight; click to see popups with metadata.

## Notes

- Data is synthetic, generated per query with deterministic randomness.
- Categories detected from the query: crops, water, forest, urban; default is generic.
