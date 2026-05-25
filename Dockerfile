FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
# Install curl and wget which are needed for the backend
RUN apt-get update && apt-get install -y curl wget && rm -rf /var/lib/apt/lists/*
EXPOSE 7860
ENV PORT=7860
CMD ["npm", "start"]
