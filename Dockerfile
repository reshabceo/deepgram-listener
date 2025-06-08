FROM node:18-slim

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies with specific flags to handle all requirements
RUN npm install --legacy-peer-deps --force

# Copy app source
COPY . .

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"] 
