# Deploying Wildcall Online (Render + Neon)

This takes about 15 minutes. Render runs the Node server with WebSockets, and Neon provides a free Postgres database that doesn't expire.

## 1. Put the code on GitHub

Create a repository and push this folder to it. `public/art` is about 40 MB, which is fine for GitHub.

## 2. Create the database (Neon)

1. Sign up at neon.tech and create a project.
2. Copy the connection string. It looks like `postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`.

The server creates its tables the first time it starts.

## 3. Create the web service (Render)

1. On render.com, choose **New → Web Service** and connect your GitHub repository.
2. Use these settings:
   - **Runtime:** Node
   - **Build command:** `npm install && npm run build`
   - **Start command:** `npm start`
   - **Instance type:** Starter ($7/month) is recommended. The free type sleeps after 15 idle minutes, and the next visitor waits about a minute for it to wake. That also drops anyone who was mid-match.
3. Add these environment variables:
   - `DATABASE_URL`: the Neon connection string
   - `ADMIN_USERNAMES`: the username you'll sign up with, e.g. `jeremy`
   - `NODE_ENV`: `production`
4. Click **Create Web Service**. When it's live, open the URL and sign up with your admin username.

Alternatively, `render.yaml` is a blueprint. Use **New → Blueprint** and fill in `DATABASE_URL`.

**Keep it at one instance.** Matchmaking and live matches are held in memory, so don't turn on autoscaling.

## 4. Your own domain (optional)

In Render, go to **Settings → Custom Domains** and add your domain, e.g. `play.wildcall.gg`. Then add the CNAME record it shows you at your domain registrar. Render provides HTTPS automatically, and HTTPS is required for secure login cookies.

## Other hosts

Railway, Fly.io and any VPS work the same way: run `npm run build`, then `npm start`, with the same environment variables. If you'd rather not use a separate Postgres on a single VPS, leave `DATABASE_URL` unset and set `PGLITE_DIR=/var/lib/wildcall` on a persistent disk.

## Backups

Neon keeps point-in-time history on its free tier. You can also run `pg_dump "$DATABASE_URL" > backup.sql` regularly.

## Updating without kicking players out (maintenance mode)

1. Open **Admin**. In the **Maintenance** panel, type a message for players (optional) and click **Start maintenance**.
   - New ranked matches, friend challenges and story duels are paused. Players see an orange banner.
   - Matches already running keep going and pay out normally.
2. Wait until the panel shows **✓ Clear to update**. The game locks itself the moment the last live match ends. You can also click **Lock now** to skip the wait.
   - Once it's locked, players see a "We'll be right back" screen. Admins can still play.
3. Push your update. Render redeploys it. The lock is saved in the database, so the game stays locked through the restart.
4. When the new version is live, click **End maintenance**. Players waiting on the maintenance screen get back in automatically within about 10 seconds.
