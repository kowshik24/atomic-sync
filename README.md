# Atomic Sync - Obsidian Plugin

Real-time, end-to-end encrypted sync for Obsidian using Supabase.

## Features

- 🔄 Real-time sync across devices
- 🔒 End-to-end encryption (AES-GCM-256)
- 📱 Cross-platform (desktop, mobile, tablet)
- ☁️ Self-hosted with Supabase
- 📡 Offline support

## Setup

### 1. Supabase Configuration

1. Create a [Supabase](https://supabase.com) project
2. Run the SQL from `supabase_schema.sql` in SQL Editor
3. Enable Realtime:
   - **Database** → **Publications** → **supabase_realtime**
   - Toggle **ON** for `updates` table
4. Get credentials from **Settings** → **API**:
   - Project URL
   - Anon Key

### 2. Installation

```bash
# Clone and install
git clone https://github.com/kowshik24/atomic-sync.git
cd atomic-sync
npm install

# Build
npm run build
```

Copy `main.js` and `manifest.json` to `.obsidian/plugins/atomic-sync/` in your vault.

### 3. Plugin Configuration

1. Enable plugin in Obsidian Settings → Community Plugins
2. Configure in Settings → Atomic Sync:
   - Supabase URL
   - Supabase Anon Key
   - Vault Password (same on all devices)

## Usage

The plugin syncs automatically. Type in any note and changes sync in real-time.

**Verify sync:**
- Check Supabase Dashboard → Table Editor → `updates` table
- You'll see encrypted binary blobs (your changes)

## Development

```bash
npm run dev   # Watch mode
npm run build # Production build
```

## Troubleshooting

**Row Level Security error:**
```sql
-- Run this in Supabase SQL Editor
drop policy if exists "Enable all access for authenticated users" on "documents";
drop policy if exists "Enable all access for authenticated users" on "updates";

create policy "Enable all access for anon users" on "documents"
as permissive for all to anon using (true) with check (true);

create policy "Enable all access for anon users" on "updates"
as permissive for all to anon using (true) with check (true);
```

**Decryption errors:**
- Use the same vault password on all devices
- Clear database: `delete from updates; delete from documents;`

## Architecture

- **CRDT**: Yjs for conflict-free merging
- **Encryption**: PBKDF2 + AES-GCM (client-side)
- **Backend**: Supabase (PostgreSQL + Realtime)
- **Offline**: IndexedDB

## License

MIT
