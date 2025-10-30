name: Run Discord Bot

on:
  push:
    branches: [ main ]
  workflow_dispatch:

jobs:
  run-bot:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Start bot
        env:
          DISCORD_TOKEN: ${{ secrets.DISCORD_TOKEN }}
        run: node index.js
