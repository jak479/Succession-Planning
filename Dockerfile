# Owner exit workspace server (proof of concept). Built and deployed by .github/workflows/deploy.yml.
FROM node:22-slim
WORKDIR /app
COPY core/package.json core/package-lock.json core/
RUN cd core && npm ci --omit=dev
COPY server/package.json server/package-lock.json server/
RUN cd server && npm ci --omit=dev
COPY core core
COPY server/src server/src
COPY web web
# The drafting tool reads its templates at run time (core/src/templates.ts); the wording lives only there.
COPY docs/templates docs/templates
ENV NODE_ENV=production
USER node
CMD ["node", "--experimental-strip-types", "server/src/main.ts"]
