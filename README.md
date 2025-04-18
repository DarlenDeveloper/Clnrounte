# Telnyx Speech Assistant with OpenAI Realtime API

This project implements an AI voice assistant using Telnyx's Voice API and OpenAI's Realtime API. It was created for AIRIES AI, a company in Uganda that builds customer care agents for businesses.

## Features

- Handles incoming calls via Telnyx's Voice API
- Connects to OpenAI's Realtime API for natural language processing
- Streams audio bidirectionally between the caller and OpenAI
- Automatically detects resolution status based on conversation content
- Sends call data to a custom webhook for further processing, including:
  - user_id (company UUID)
  - caller_number
  - status (Resolved/Unresolved)
  - notes (call summary)

## Prerequisites

- Node.js (v16 or higher)
- Telnyx account with a phone number
- OpenAI API key with access to the Realtime API
- Webhook URL (e.g., make.com) for receiving call data

## Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file based on `.env.example`:
   ```
   OPENAI_API_KEY=your_openai_api_key
   TELNYX_API_KEY=your_telnyx_api_key
   COMPANY_UUID=your_company_uuid
   WEBHOOK_URL=your_make_com_webhook_url
   PORT=5050
   ```

4. Configure your Telnyx phone number to point to your server's `/incoming-call` endpoint

## Running the Server

Start the server with:

```
npm start
```

The server will listen on the port specified in your `.env` file (default: 5050).

## How It Works

1. When a call comes in to your Telnyx number, Telnyx sends a request to your `/incoming-call` endpoint
2. The server responds with TeXML instructions to stream the call audio to the `/media-stream` WebSocket endpoint
3. The server establishes a WebSocket connection with OpenAI's Realtime API
4. Audio from the caller is streamed to OpenAI, and responses from OpenAI are streamed back to the caller
5. The conversation is tracked and analyzed for resolution status
6. When the call ends, call data is sent to the configured webhook with the following structure:
   ```json
   {
     "user_id": "company-uuid-here",
     "caller_number": "+1234567890",
     "status": "Resolved",
     "notes": "Summary of the conversation..."
   }
   ```

## Customization

You can customize the AI assistant's behavior by modifying the `SYSTEM_MESSAGE` constant in `index.js`.

## Endpoints

- `GET /` - Health check endpoint
- `POST /incoming-call` - Endpoint for Telnyx to send incoming call notifications
- `WebSocket /media-stream` - WebSocket endpoint for streaming call audio
- `POST /update-status` - Manually update the resolution status of the current call

## Webhook Integration

Call data is sent to the webhook URL specified in your `.env` file when a call ends. The data includes:
- user_id (company UUID)
- caller_number
- status (Resolved/Unresolved)
- notes (call summary)

## License

ISC
