FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

# Copy standalone backend API proxy server script (uses native Node 20 APIs)
COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
