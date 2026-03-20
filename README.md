# Ticket Overdue Bot

This bot watches text channels whose names start with your configured ticket prefix, such as `ticket-`.

## What it does
- If a non-staff user sends the most recent message in a tracked ticket channel, the wait timer starts.
- If a staff member replies, the wait cycle resets.
- At the configured staff alert time, the bot DMs every current member of the configured role.
- At the configured owner alert time, the bot DMs the configured owner user ID.
- Both alerts are sent as embeds.

## Editable config
Everything important is editable in `config.json`:
- server/guild ID
- ticket channel prefix
- staff role IDs
- role to DM at the first alert
- owner user ID for the escalation alert
- hours until first alert
- hours until owner alert
- scan interval
- embed footer and colors

## Files
- `index.js` - main bot logic
- `config.json` - editable settings
- `package.json` - dependencies
- `render.yaml` - optional Render Blueprint config

## Required Discord bot intents
Turn these on in the Discord Developer Portal:
- Server Members Intent
- Message Content Intent

## Local start
1. Put your bot token into `config.json`
2. Run `npm install`
3. Run `npm start`

## Render note
For Render, it is safer to put the token in an environment variable named `BOT_TOKEN` instead of storing it in `config.json`.
