FROM node:20-bookworm AS build

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    make \
    gcc \
    g++ \
    libc6-dev \
    git \
    rsync \
    curl \
 && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Download shareware WAD
RUN curl -fsSL -o /app/doom1.wad \
    https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad

# Fetch upstream doomgeneric sources
RUN git clone https://github.com/ozkl/doomgeneric.git /tmp/doomgeneric-upstream \
 && rsync -av --ignore-existing /tmp/doomgeneric-upstream/doomgeneric/ /app/doomgeneric/ \
 && rm -rf /tmp/doomgeneric-upstream

# Build + fix expected paths
RUN make -C doomgeneric -f Makefile.server \
 && mkdir -p /app/doomgeneric/doomgeneric \
 && ln -sf ../doomgeneric_server /app/doomgeneric/doomgeneric/doomgeneric_server \
 && ln -sf /app/doom1.wad /app/doomgeneric/doomgeneric/doom1.wad

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
