CREATE TABLE players (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE,
  room TEXT DEFAULT 'Capital',
  gold INT DEFAULT 0,
  food INT DEFAULT 0,
  wood INT DEFAULT 0,
  stone INT DEFAULT 0,
  hunger INT DEFAULT 100,
  status TEXT DEFAULT 'Peasant'
);
