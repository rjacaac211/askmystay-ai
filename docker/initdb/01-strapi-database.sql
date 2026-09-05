-- Strapi keeps its own tables in a separate database on the same instance:
-- one Postgres to run, but no chance of the CMS's migrations colliding with
-- the app's guidebook_chunks/bookings schema.
--
-- Runs only when the data volume is created empty. On an existing volume,
-- create it by hand:
--   docker compose exec postgres psql -U askmystay -d askmystay \
--     -c "CREATE DATABASE strapi OWNER askmystay"
CREATE DATABASE strapi OWNER askmystay;
