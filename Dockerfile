FROM node:22-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev \
    && find /app/node_modules -name Dockerfile -type f -delete
COPY . .

FROM node:22-alpine AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /app /app
COPY --chown=root:root entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
    && mkdir -p /home/node/.config/actualplaid-cli-nodejs \
    && chown node:node /app \
    && chown -R node:node /home/node/.config/actualplaid-cli-nodejs \
    && rm -rf /usr/local/lib/node_modules/npm \
    && rm -f /usr/local/bin/npm /usr/local/bin/npx
USER node
ENTRYPOINT ["/entrypoint.sh"]
CMD ["server"]
