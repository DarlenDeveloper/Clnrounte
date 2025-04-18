import Fastify from 'fastify';
import WebSocket from 'ws';
import dotenv from 'dotenv';
import fastifyFormBody from '@fastify/formbody';
import fastifyWs from '@fastify/websocket';

// Load environment variables from .env file
dotenv.config();

// Retrieve environment variables
const { 
  OPENAI_API_KEY, 
  TELNYX_API_KEY, 
  COMPANY_UUID,
  WEBHOOK_URL,
  PORT 
} = process.env;

// Validate required environment variables
if (!OPENAI_API_KEY) {
    console.error('Missing OpenAI API key.');
    process.exit(1);
}

if (!TELNYX_API_KEY) {
    console.error('Missing Telnyx API key.');
    process.exit(1);
}

// Initialize Fastify
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Constants
const SYSTEM_MESSAGE = 'You are a helpful and professional AI assistant for AIRIES AI. You job is a customer care agent and you are supposed to extract information from the user on matters concerning the Airies ai customer care agent product. You will also ask then for their availablity. Always stay positive and professional. Your goal is to act as an efficient customer care agent and resolve customer issues efficiently.';
const VOICE = 'alloy';
const SERVER_PORT = PORT || 5050; // Allow dynamic port assignment

// List of Event Types to log to the console. 
const LOG_EVENT_TYPES = [
    'error',
    'response.content.done',
    'rate_limits.updated',
    'response.done',
    'input_audio_buffer.committed',
    'input_audio_buffer.speech_stopped',
    'input_audio_buffer.speech_started',
    'session.created'
];

// Show AI response elapsed timing calculations
const SHOW_TIMING_MATH = false;

// Call data for webhook
let currentCallData = {
    user_id: COMPANY_UUID,
    caller_number: null,
    status: 'Unresolved',
    notes: ''
};

// Function to send call data to webhook
async function saveCallData() {
    try {
        // Generate summary if conversation exists
        if (currentCallData.conversation && currentCallData.conversation.length > 0) {
            // Create a summary from the conversation
            const summaryText = currentCallData.conversation.map(item => 
                `${item.role}: ${item.content}`
            ).join('\\n');
            
            currentCallData.notes = summaryText.length > 500 ? 
                summaryText.substring(0, 497) + '...' : 
                summaryText;
        }

        // Remove the conversation array before sending to webhook
        const { conversation, ...dataToSend } = currentCallData;

        // Send data to webhook if URL is provided
        if (WEBHOOK_URL) {
            try {
                console.log('Sending data to webhook:', dataToSend);
                const response = await fetch(WEBHOOK_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify(dataToSend),
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                
                console.log('Call data sent to webhook successfully');
            } catch (webhookError) {
                console.error('Error sending data to webhook:', webhookError);
            }
        } else {
            console.log('No webhook URL provided, skipping webhook call');
        }
    } catch (e) {
        console.error('Error in saveCallData:', e);
    }
}

// Root Route
fastify.get('/', async (request, reply) => {
    reply.send({ message: 'Telnyx Media Stream Server is running!' });
});

// Route for Telnyx to handle incoming calls
fastify.all('/incoming-call', async (request, reply) => {
    // Telnyx uses TeXML (similar to Twilio's TwiML)
    const texmlResponse = `<?xml version="1.0" encoding="UTF-8"?>
                          <Response>
                              <Say>Thank you for calling AIRIES AI TECHNOLOGIES.</Say>
                              <Pause length="1"/>
                              <Say>May i know who am speaking to?</Say>
                              <Stream url="wss://${request.headers.host}/media-stream" />
                          </Response>`;

    // Reset call data for new call
    currentCallData = {
        user_id: COMPANY_UUID,
        caller_number: request.body?.from || 'unknown',
        status: 'Unresolved',
        notes: '',
        conversation: [] // Used internally, not sent to webhook
    };

    reply.type('text/xml').send(texmlResponse);
});

// WebSocket route for media-stream
fastify.register(async (fastify) => {
    fastify.get('/media-stream', { websocket: true }, (connection, req) => {
        console.log('Client connected');

        // Connection-specific state
        let streamId = null;
        let latestMediaTimestamp = 0;
        let lastAssistantItem = null;
        let markQueue = [];
        let responseStartTimestampTelnyx = null;

        const openAiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
            headers: {
                Authorization: `Bearer ${OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1"
            }
        });

        // Control initial session with OpenAI
        const initializeSession = () => {
            const sessionUpdate = {
                type: 'session.update',
                session: {
                    turn_detection: { type: 'server_vad' },
                    input_audio_format: 'g711_ulaw',
                    output_audio_format: 'g711_ulaw',
                    voice: VOICE,
                    instructions: SYSTEM_MESSAGE,
                    modalities: ["text", "audio"],
                    temperature: 0.8,
                }
            };

            console.log('Sending session update:', JSON.stringify(sessionUpdate));
            openAiWs.send(JSON.stringify(sessionUpdate));

            // Uncomment the following line to have AI speak first:
            // sendInitialConversationItem();
        };

        // Send initial conversation item if AI talks first
        const sendInitialConversationItem = () => {
            const initialConversationItem = {
                type: 'conversation.item.create',
                item: {
                    type: 'message',
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: 'Greet the user with "Hello there! I am an AI customer care agent for AIRIES AI. How can I help you today?"'
                        }
                    ]
                }
            };

            if (SHOW_TIMING_MATH) console.log('Sending initial conversation item:', JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify(initialConversationItem));
            openAiWs.send(JSON.stringify({ type: 'response.create' }));
            
            // Add to conversation history
            currentCallData.conversation.push({
                role: 'assistant',
                content: 'Hello there! I am an AI voice assistant for AIRIES AI. How can I help you today?'
            });
        };

        // Handle interruption when the caller's speech starts
        const handleSpeechStartedEvent = () => {
            if (markQueue.length > 0 && responseStartTimestampTelnyx != null) {
                const elapsedTime = latestMediaTimestamp - responseStartTimestampTelnyx;
                if (SHOW_TIMING_MATH) console.log(`Calculating elapsed time for truncation: ${latestMediaTimestamp} - ${responseStartTimestampTelnyx} = ${elapsedTime}ms`);

                if (lastAssistantItem) {
                    const truncateEvent = {
                        type: 'conversation.item.truncate',
                        item_id: lastAssistantItem,
                        content_index: 0,
                        audio_end_ms: elapsedTime
                    };
                    if (SHOW_TIMING_MATH) console.log('Sending truncation event:', JSON.stringify(truncateEvent));
                    openAiWs.send(JSON.stringify(truncateEvent));
                }

                connection.send(JSON.stringify({
                    event: 'clear',
                    streamId: streamId
                }));

                // Reset
                markQueue = [];
                lastAssistantItem = null;
                responseStartTimestampTelnyx = null;
            }
        };

        // Send mark messages to Media Streams so we know if and when AI response playback is finished
        const sendMark = (connection, streamId) => {
            if (streamId) {
                const markEvent = {
                    event: 'mark',
                    streamId: streamId,
                    mark: { name: 'responsePart' }
                };
                connection.send(JSON.stringify(markEvent));
                markQueue.push('responsePart');
            }
        };

        // Open event for OpenAI WebSocket
        openAiWs.on('open', () => {
            console.log('Connected to the OpenAI Realtime API');
            setTimeout(initializeSession, 100);
        });

        // Listen for messages from the OpenAI WebSocket (and send to Telnyx if necessary)
        openAiWs.on('message', (data) => {
            try {
                const response = JSON.parse(data);

                if (LOG_EVENT_TYPES.includes(response.type)) {
                    console.log(`Received event: ${response.type}`, response);
                }

                // Handle text responses for conversation history
                if (response.type === 'response.content.delta' && response.delta && response.delta.type === 'text') {
                    // Add assistant response to conversation history
                    if (!currentCallData.conversation.find(item => item.role === 'assistant' && item.tempId === response.item_id)) {
                        currentCallData.conversation.push({
                            role: 'assistant',
                            content: response.delta.text,
                            tempId: response.item_id
                        });
                    } else {
                        // Append to existing response
                        const assistantResponse = currentCallData.conversation.find(
                            item => item.role === 'assistant' && item.tempId === response.item_id
                        );
                        if (assistantResponse) {
                            assistantResponse.content += response.delta.text;
                        }
                    }
                    
                    // Check for resolution status in assistant responses
                    const lowerContent = currentCallData.conversation
                        .filter(item => item.role === 'assistant')
                        .map(item => item.content.toLowerCase())
                        .join(' ');
                    
                    if (
                        lowerContent.includes('resolved') || 
                        lowerContent.includes('issue fixed') || 
                        lowerContent.includes('problem solved') ||
                        lowerContent.includes('completed successfully')
                    ) {
                        currentCallData.status = 'Resolved';
                    }
                }

                if (response.type === 'response.audio.delta' && response.delta) {
                    const audioDelta = {
                        event: 'media',
                        streamId: streamId,
                        media: { payload: response.delta }
                    };
                    connection.send(JSON.stringify(audioDelta));

                    // First delta from a new response starts the elapsed time counter
                    if (!responseStartTimestampTelnyx) {
                        responseStartTimestampTelnyx = latestMediaTimestamp;
                        if (SHOW_TIMING_MATH) console.log(`Setting start timestamp for new response: ${responseStartTimestampTelnyx}ms`);
                    }

                    if (response.item_id) {
                        lastAssistantItem = response.item_id;
                    }
                    
                    sendMark(connection, streamId);
                }

                if (response.type === 'input_audio_buffer.speech_started') {
                    handleSpeechStartedEvent();
                }
                
                // When a response is complete, check if we need to save call data
                if (response.type === 'response.done') {
                    console.log('Response complete, checking if call is ending');
                }
            } catch (error) {
                console.error('Error processing OpenAI message:', error, 'Raw message:', data);
            }
        });

        // Handle incoming messages from Telnyx
        connection.on('message', (message) => {
            try {
                const data = JSON.parse(message);

                switch (data.event) {
                    case 'media':
                        latestMediaTimestamp = data.media.timestamp;
                        if (SHOW_TIMING_MATH) console.log(`Received media message with timestamp: ${latestMediaTimestamp}ms`);
                        if (openAiWs.readyState === WebSocket.OPEN) {
                            const audioAppend = {
                                type: 'input_audio_buffer.append',
                                audio: data.media.payload
                            };
                            openAiWs.send(JSON.stringify(audioAppend));
                        }
                        break;
                    case 'start':
                        streamId = data.start.streamId;
                        console.log('Incoming stream has started', streamId);
                        
                        // Set caller number if available
                        if (data.start.from) {
                            currentCallData.caller_number = data.start.from;
                        }

                        // Reset start and media timestamp on a new stream
                        responseStartTimestampTelnyx = null; 
                        latestMediaTimestamp = 0;
                        break;
                    case 'mark':
                        if (markQueue.length > 0) {
                            markQueue.shift();
                        }
                        break;
                    case 'stop':
                        console.log('Stream stopped, saving call data');
                        saveCallData();
                        break;
                    default:
                        console.log('Received non-media event:', data.event);
                        break;
                }
            } catch (error) {
                console.error('Error parsing message:', error, 'Message:', message);
            }
        });

        // Handle connection close
        connection.on('close', () => {
            if (openAiWs.readyState === WebSocket.OPEN) openAiWs.close();
            console.log('Client disconnected, saving call data');
            saveCallData();
        });

        // Handle WebSocket close and errors
        openAiWs.on('close', () => {
            console.log('Disconnected from the OpenAI Realtime API');
        });

        openAiWs.on('error', (error) => {
            console.error('Error in the OpenAI WebSocket:', error);
        });
    });
});

// Endpoint to manually update resolution status
fastify.post('/update-status', async (request, reply) => {
    const { status } = request.body;
    
    if (status === 'Resolved' || status === 'Unresolved') {
        currentCallData.status = status;
        reply.send({ success: true, message: `Resolution status updated to ${status}` });
    } else {
        reply.code(400).send({ success: false, message: 'Invalid status. Use "Resolved" or "Unresolved".' });
    }
});

// Start the server
fastify.listen({ port: SERVER_PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log(`Server is listening on port ${SERVER_PORT}`);
});
