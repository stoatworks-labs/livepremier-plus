FROM node:22-alpine

WORKDIR /app

# No dependencies: package.json is copied for metadata and the bin entry only.
COPY package.json ./
COPY server/ ./server/
COPY src/ ./src/

# Inside a container the loopback default would make the app unreachable, so
# bind wide here — the container boundary is what limits exposure, and the
# operator chose to publish the port.
ENV LPP_HOST=0.0.0.0
ENV LPP_PORT=8535
ENV LPP_DATA=/config
EXPOSE 8535

# Cue stacks and the remembered switcher live here; mount it to keep them.
VOLUME ["/config"]

USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LPP_PORT||8535)+'/__lpp/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
