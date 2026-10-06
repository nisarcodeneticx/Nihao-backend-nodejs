# Nihao Node backend

This folder is a Node.js copy of the Spring Boot API. It uses Supabase Postgres and does not change the Spring Boot project.

The routes are the same, under `/api`.

| | |
|---|---|
| Admin page | http://localhost:8090/ and, on Vercel, the site root `/` |
| Admin login | `POST /api/auth/login` |
| Mobile login | `POST /api/v1/api/login` |
| Mobile register | `POST /api/v1/api/register` |
| Google sign-in | `POST /api/v1/api/auth/google` |

Seeded accounts, created on first start:

| Role | Email | Password |
|---|---|---|
| Admin | `admin@nihao-urdu.com` | `admin123` |
| Student | `student@nihao-urdu.com` | `student123` |

## Supabase

1. Create a free project at [supabase.com](https://supabase.com).
2. In **Project Settings → Database**, copy the **Session pooler** connection string (port `6543`).
3. Copy `.env.example` to `.env` and set `DATABASE_URL` to that string. Also set `JWT_SECRET`.
4. Install and start:

```bat
npm install
npm start
```

The tables are created automatically the first time the server starts. Data stays in Supabase when this server stops.

On Vercel, set the project root to this `node-backend` folder and add the same `DATABASE_URL` and `JWT_SECRET` environment variables. Do not set a build command.
