# Over2u frontend

React 19, Vite, and React Router landing page, signup, and sign-in UI.

## Run locally

Run `npm ci`, then `npm run dev` in this directory. Start the existing backend on port 5000. Vite proxies `/api` to that backend. For a separately hosted backend, copy `.env.example` to `.env` and set `VITE_API_BASE_URL` to its API root (including `/api`). Production hosting must route `/api` to the backend or configure this variable at build time.

## Authentication integration

The home page is `/`. Registration lives at `/signup`, and sign-in at `/signin`. `/register` and `/auth` redirect to `/signup`; `/login` redirects to `/signin`. Legacy `/#signup` and `/#signin` links redirect to their corresponding page routes. Unknown paths display a 404 page with a home link. Internal navigation uses React Router and supports browser back/forward. Landing-page section links scroll to their target after navigation.

Production hosting must serve `index.html` for frontend paths such as `/signup` and `/signin` so direct links and refreshes work. Keep `/api` requests routed to the backend. Vite's development and preview servers handle the frontend fallback automatically.

The API layer in `src/api/auth.js` uses the existing `POST /api/auth/register` and `POST /api/auth/login` endpoints. The signup username maps to the backend's `name` field; the backend does not enforce unique usernames. Password constraints match its 8–200 character registration schema.

Successful responses remain in React memory and emit a `relay:authenticated` CustomEvent with `{ token, user }`, allowing a future authentication provider to consume the session. Reloading clears the session. There is no dashboard in this starter, so successful authentication displays confirmation instead of redirecting to an invented route.

Terms and privacy controls display an explicit unpublished-policy notice until real legal pages are supplied.

## Checks

`npm run build` and `npm run lint`.
