FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with legacy peer deps flag to handle compatibility
RUN npm install --legacy-peer-deps

# Copy app source
COPY . .

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"] 