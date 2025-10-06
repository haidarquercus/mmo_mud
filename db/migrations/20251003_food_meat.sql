-- (same ALTER TABLE as above)
-- plus the supporting tables we rely on:

CREATE TABLE IF NOT EXISTS player_tools (
  id BIGSERIAL PRIMARY KEY,
  player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  tool_key TEXT NOT NULL CHECK (tool_key IN ('bow','pickaxe')),
  durability INT NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_player_tools_player ON player_tools(player_id);

CREATE TABLE IF NOT EXISTS player_effects (
  id BIGSERIAL PRIMARY KEY,
  player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  effect TEXT NOT NULL,
  magnitude INT NOT NULL DEFAULT 1,
  expires_at TIMESTAMP NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_effects_player ON player_effects(player_id);
CREATE INDEX IF NOT EXISTS idx_player_effects_exp ON player_effects(expires_at);

CREATE TABLE IF NOT EXISTS bounties (
  id BIGSERIAL PRIMARY KEY,
  target_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  amount INT NOT NULL,
  reason TEXT,
  active BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS owner_player_id INT REFERENCES players(id),
  ADD COLUMN IF NOT EXISTS price_food INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS price_meat INT DEFAULT 3,
  ADD COLUMN IF NOT EXISTS price_wood INT DEFAULT 1,
  ADD COLUMN IF NOT EXISTS price_stone INT DEFAULT 2,
  ADD COLUMN IF NOT EXISTS price_bow INT DEFAULT 20,
  ADD COLUMN IF NOT EXISTS price_pickaxe INT DEFAULT 25;

CREATE TABLE IF NOT EXISTS tiles (
  id BIGSERIAL PRIMARY KEY,
  room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  x INT NOT NULL, y INT NOT NULL,
  terrain TEXT DEFAULT 'plains',
  living_quality INT DEFAULT 0,
  UNIQUE(room_id, x, y)
);

CREATE TABLE IF NOT EXISTS homes (
  id BIGSERIAL PRIMARY KEY,
  player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  x INT NOT NULL, y INT NOT NULL,
  tier TEXT NOT NULL DEFAULT 'shack',
  UNIQUE(player_id),
  UNIQUE(room_id, x, y)
);

CREATE TABLE IF NOT EXISTS market_makers (
  id BIGSERIAL PRIMARY KEY,
  room_id INT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  player_id INT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  resource TEXT NOT NULL CHECK (resource IN ('wood','stone','food','meat')),
  day_id BIGINT NOT NULL,
  percent INT NOT NULL DEFAULT 10,
  UNIQUE (room_id, resource, day_id)
);
