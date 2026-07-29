FROM registry.gz.cvte.cn/ccloud/jenkins-jnlp-node:18.16.1
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["sh","-c","node server.js"]
