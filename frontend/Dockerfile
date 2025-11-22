# Development Dockerfile for Next.js
FROM node:20-alpine

# Add libc6-compat for Alpine
RUN apk add --no-cache libc6-compat

WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies (not using npm ci since we don't have package-lock.json)
RUN npm install

# Copy the rest of the application
COPY . .

EXPOSE 3000

ENV PORT 3000

# Default command (can be overridden by docker-compose)
CMD ["npm", "run", "dev"]