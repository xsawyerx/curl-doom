FROM node:20-bookworm AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    make \
    gcc \
    g++ \
    libc6-dev \
    git \
    curl \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Download shareware WAD
RUN curl -fsSL -o /app/doom1.wad \
    https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad

# Fetch upstream doomgeneric sources
RUN git clone https://github.com/ozkl/doomgeneric.git doomgeneric/doomgeneric

# Build + delete temporary files to make runtime image smaller
RUN make -C doomgeneric -f Makefile.server \
 && rm -rf /app/doomgeneric/doomgeneric \
 && rm -rf /app/doomgeneric/build_server

FROM node:20-bookworm-slim AS runtime

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000

COPY --from=build /app /app

EXPOSE 3000

CMD ["npm", "start"]
