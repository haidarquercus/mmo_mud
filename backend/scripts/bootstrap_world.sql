-- backend/scripts/bootstrap_world.sql
CREATE TABLE IF NOT EXISTS players (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE,
  token TEXT UNIQUE,
  room TEXT DEFAULT 'Capital',
  role TEXT DEFAULT 'Peasant',
  gold INT DEFAULT 0,
  food INT DEFAULT 0,
  meat INT DEFAULT 0,
  wood INT DEFAULT 0,
  stone INT DEFAULT 0,
  hunger INT DEFAULT 100,
  wanted BOOLEAN DEFAULT false,
  socket_id TEXT,
  last_seen TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rooms (
  id SERIAL PRIMARY KEY,
  name TEXT UNIQUE,
  terrain TEXT DEFAULT 'plains',
  living_quality INT DEFAULT 0,
  distance_from_capital INT DEFAULT 1,
  tax_rate INT DEFAULT 10,
  owner_player_id INT,
  world_x INT,
  world_y INT,
  price_food INT DEFAULT 1,
  price_meat INT DEFAULT 3,
  price_wood INT DEFAULT 1,
  price_stone INT DEFAULT 2,
  price_bow INT DEFAULT 20,
  price_pickaxe INT DEFAULT 25
);

INSERT INTO rooms (name, terrain, living_quality, distance_from_capital, tax_rate)
VALUES ('Capital', 'plains', 0, 1, 10)
ON CONFLICT (name) DO NOTHING;
