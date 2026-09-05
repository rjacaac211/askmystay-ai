# Strapi needs libvips (sharp) and a toolchain to build its admin panel, so the
# build stage carries them and the runtime stage does not.
FROM node:22-alpine AS builder
RUN apk add --no-cache build-base gcc autoconf automake zlib-dev libpng-dev nasm bash vips-dev git
WORKDIR /opt/app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Compiles src/**/*.ts into dist/ and bundles the admin panel.
RUN npm run build

FROM node:22-alpine
RUN apk add --no-cache vips
WORKDIR /opt/app
ENV NODE_ENV=production
COPY --from=builder /opt/app ./
EXPOSE 1337
CMD ["npm", "run", "start"]
