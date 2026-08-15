FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
