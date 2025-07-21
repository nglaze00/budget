'use client';

import { useEffect, useRef, useState } from 'react';
import ChatInput from '../components/ChatInput';
import ChatMessage from '../components/ChatMessage';

interface Message {
  user_message: string;
  sender: 'user' | 'ai';
  isPendingTool?: boolean;
  toolResult?: { status: string; message: string };
}

export default function Home() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // ✅ Toggle this flag to switch between streaming and non-streaming
  const USE_STREAMING = true; // Set to false for simple non-streaming chat

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    if (input.trim() === '') return;
    
    const newUserMessage: Message = { user_message: input, sender: 'user' };
    setMessages((prevMessages) => [...prevMessages, newUserMessage]);
    setInput('');
    setLoading(true);

    if (USE_STREAMING) {
      await handleStreamingChat(newUserMessage);
    } else {
      await handleSimpleChat(newUserMessage);
    }
  };

  const newChat = async () => {
    try {
      const backendUrl = 'http://localhost:8000/newChat';
      
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // Clear the messages to start a new chat
      setMessages([]);
      setInput('');
    } catch (error: any) {
      console.error('Error starting new chat:', error);
      // Optionally show an error message to the user
      const errorMessage: Message = { 
        user_message: `Failed to start new chat: ${error.message || 'Unknown error'}`, 
        sender: 'ai' 
      };
      setMessages((prevMessages) => [...prevMessages, errorMessage]);
    }
  };

  // 🔄 STREAMING VERSION
  const handleStreamingChat = async (newUserMessage: Message) => {
    // Add placeholder for AI response with "Thinking..." text
    let currentAIMessage: Message = { user_message: 'Thinking...', sender: 'ai' };
    setMessages((prevMessages) => [...prevMessages, currentAIMessage]);

    try {
      const backendUrl = 'http://localhost:8000/chatStream';

      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_message: newUserMessage.user_message,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
      }

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();
      let accumulatedResponse = '';
      let hasStartedStreaming = false;

      while (true && reader) {
        const { done, value } = await reader.read();
        if (done) break;

        const eventsStr = decoder.decode(value, { stream: true });
        const events = eventsStr.split('\n').filter(Boolean).map((line) => JSON.parse(line));
        const toolsQueue = [];

        for (const event of events) {
          if (event.type === 'message_chunk') {
            accumulatedResponse += event.data.replace('~', '\~');
            hasStartedStreaming = true;
          }
          else if (event.type === 'tool_call') {
            const toolCallName = event.name;
            const toolCallArgs = JSON.parse(event.arguments);
            console.log('Tool call:', toolCallName, toolCallArgs);

            // Add tool call to the queue
            toolsQueue.push({ name: toolCallName, args: toolCallArgs });

            // Add a message indicating the tool call
            let toolCallMessage: string;
            if (toolCallName === 'query_table') {
              const query = toolCallArgs.sql_query;
              const outputTableName = toolCallArgs.output_table_name || '';

              toolCallMessage = `**🤖 Running SQL query**:

\`\`\`sql
${query}
\`\`\``
              if (outputTableName)   {
                toolCallMessage += `\n\n🗃️ Saving result to intermediate table \`${outputTableName}\`...`;
              } else {
                toolCallMessage += `\n\n🔄 Returning result...`;
              }
            } else if (toolCallName === 'plot') {
                toolCallMessage = `🤖 Plotting \`${toolCallArgs.y_cols}\` against \`${toolCallArgs.x_col}\`...`;
            } else if (toolCallName === 'math') {
              toolCallMessage = `🤖 Doing math: ${toolCallArgs.expr}`;
            } else if (toolCallName === 'get_table_schema') {
              toolCallMessage = `🤖 Getting schema for table \`${toolCallArgs.table_name}\``;
            } else if (toolCallName === 'get_semantically_relevant_transactions') {
              toolCallMessage = `🤖 Getting transactions related to "${toolCallArgs.query}"...`;
            } else {
              toolCallMessage = `🤖 Called tool: ${toolCallName}`;
            }
            // insert a message right before "Thinking..." that includes this result
            setMessages((prevMessages) => [
              ...prevMessages.slice(0, -1), // Keep all previous messages except the last one
              {
                ...currentAIMessage,
                user_message: toolCallMessage,
              },
              ...prevMessages.slice(-1),
            ]);
          } else if (event.type === 'tool_call_output') {
            // Handle tool call output
            const toolResult = JSON.parse(event.data);
            console.log('Tool call output:', toolResult);
            let toolResultMessage: string;
            if (toolResult.name === 'get_table_schema') {
              // Format the schema output nicely
              const columns = toolResult.schema.columns.map((col: any) => {
                  let colStr = `${col.name}: ${col.type}`;
                  if (col.values && Array.isArray(col.values) && col.values.length > 0) {
                    colStr += ` = [${col.values.join(', ')}]`;
                  }
                  return colStr;
                });
                toolResultMessage = `✅ \`${toolResult.schema.table_name}\` schema retrieved:\n\n\`\`\`\n${columns.join('\n')}\n\`\`\``;
            } else if (toolResult.name === 'query_table') {
              if (toolResult.type === 'new_table_schema') {
                const columns = toolResult.schema.columns.map((col: any) => {
                  let colStr = `${col.name}: ${col.type}`;
                  if (col.values && Array.isArray(col.values) && col.values.length > 0) {
                    colStr += ` = [${col.values.join(', ')}]`;
                  }
                  return colStr;
                });
                toolResultMessage = `✅ New table \`${toolResult.schema.table_name}\` created with schema:\n\n\`\`\`\n${columns.join('\n')}\n\`\`\``;
              } else if (toolResult.type === 'result') {
                // Always render as a markdown table
                const columns = Object.keys(toolResult.data[0]);
                const header = `| ${columns.join(' | ')} |`;
                const separator = `| ${columns.map(() => '---').join(' | ')} |`;
                const rows = toolResult.data.map((row: any) =>
                  `| ${columns.map(col => String(row[col])).join(' | ')} |`
                );  
                toolResultMessage = `✅ SQL query result:\n\n${header}\n${separator}\n${rows.join('\n')}`;
              } else if (toolResult.type === 'empty_result') {
                toolResultMessage = `✅ SQL query result: No rows returned`;
              } else if (toolResult.type === 'error') {
                toolResultMessage = `❌ SQL query error: ${toolResult.error}`;
              } else {
                toolResultMessage = `Invalid tool result type: ${toolResult.type}`;
              }
            } else if (toolResult.name === 'plot') {
              console.log('Plot result:', toolResult);
              console.log('plot_base64:', toolResult.plot_base64);
              console.log('plot_base64 type:', typeof toolResult.plot_base64);
              console.log('plot_base64 length:', toolResult.plot_base64?.length);
              
              if (toolResult.plot_base64 && typeof toolResult.plot_base64 === 'string' && toolResult.plot_base64.length > 0) {
                const imageSrc = `data:image/png;base64,${toolResult.plot_base64}`;
                toolResultMessage = `✅ Plot generated:\n\n![Plot](${imageSrc})`;
              } else {
                toolResultMessage = `❌ Plot generation failed: Invalid or missing base64 data`;
              }
            } else if (toolResult.name === 'math') {
              toolResultMessage = `✅ Math result: ${toolResult.result}`;
            } else if (toolResult.name === 'get_semantically_relevant_transactions') {
              // Parse the schema result from the tool output
              const columns = toolResult.schema_result.schema.columns.map((col: any) => {
                let colStr = `${col.name}: ${col.type}`;
                if (col.values && Array.isArray(col.values) && col.values.length > 0) {
                  colStr += ` = [${col.values.join(', ')}]`;
                }
                return colStr;
              });
              toolResultMessage = `✅ Created \`${toolResult.schema_result.schema.table_name}\` table:\n\n\`\`\`\n${columns.join('\n')}\n\`\`\``;
            }
            else {
              toolResultMessage = `✅ Tool call result: ${JSON.stringify(toolResult)}`;
            }


            // insert a message right before "Thinking..." that includes this result
            setMessages((prevMessages) => [
              ...prevMessages.slice(0, -1), // Keep all previous messages except the last one
              {
                ...currentAIMessage,
                user_message: toolResultMessage,
              },
              ...prevMessages.slice(-1),
            ]);
          }
        }
        
        // Update the message with accumulated response, or keep "Thinking..." if no content yet
        setMessages((prevMessages) => {
          const updatedMessages = [...prevMessages];
          updatedMessages[updatedMessages.length - 1] = {
            ...currentAIMessage,
            user_message: hasStartedStreaming ? accumulatedResponse : 'Thinking...',
          };
          return updatedMessages;
        });
      }
    } catch (error: any) {
      console.error('Error in streaming chat:', error);
      const errorMessage: Message = { 
        user_message: `Oops! Something went wrong: ${error.message || 'Unknown error'}`, 
        sender: 'ai' 
      };
      setMessages((prevMessages) => [...prevMessages, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  // 📨 SIMPLE NON-STREAMING VERSION
  const handleSimpleChat = async (newUserMessage: Message) => {
    try {
      const backendUrl = 'http://localhost:8000/chat';

      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_message: newUserMessage.user_message,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status} - ${errorText}`);
      }

      const data = await response.json();

      const newMessages: Message[] = [];
      let lastToolName = '';
      console.log('Response data:', data);
      for (const item of data.new_items) {
        if (item.type === 'tool_call_item') {
          const toolCallName = item.raw_item.name;
          const toolCallArgs = JSON.parse(item.raw_item.arguments);

          lastToolName = toolCallName;

          if (toolCallName === 'query_table') {
            const query = toolCallArgs.sql_query;
            const outputTableName = toolCallArgs.output_table_name;

            let s = `**🤖 Making SQL query with \`query_table\`**:

\`\`\`sql
${query}
\`\`\``
            if (outputTableName) {
              s += `\n\n🗃️ Saving result to intermediate table \`${outputTableName}\`...`;
            } else {
                s += `\n\n🔄 Returning result...`
            }

            newMessages.push({
              user_message: s,
              sender: 'ai'
            });
          } else if (toolCallName === 'math') {
            const expr = toolCallArgs.expr;
            const s = `🤖 Doing math: ${expr}`;
            
            newMessages.push({
              user_message: s,
              sender: 'ai'
            });
          } else if (toolCallName === 'get_semantically_relevant_transactions') {
            const s = `🤖 Getting transactions related to "${toolCallArgs.query}"...`;

            newMessages.push({
              user_message: s,
              sender: 'ai'
            });
          }
          
        }
        else if (item.type === 'tool_call_output_item')
        {
          const s = `✅ Tool call \`${lastToolName}\` output:\n\n${item.raw_item.output}`;
        
          newMessages.push({
            user_message: s,
            sender: 'ai'
          });
        }
      }

      newMessages.push({ 
        user_message: data.message, 
        sender: 'ai' 
      });
      setMessages((prevMessages) => [...prevMessages, ...newMessages]);
    } catch (error: any) {
      console.error('Error in simple chat:', error);
      const errorMessage: Message = { 
        user_message: `Oops! Something went wrong: ${error.message || 'Unknown error'}`, 
        sender: 'ai' 
      };
      setMessages((prevMessages) => [...prevMessages, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-screen bg-gray-100 font-sans">
      <header className="bg-blue-950 text-white p-4 text-center text-2xl font-bold shadow-md relative">
        <div className="flex items-center justify-center">
          <span>Transactions Agent {USE_STREAMING ? '(Streaming)' : '(Simple)'}</span>
          <button
            onClick={newChat}
            className="absolute right-4 bg-blue-700 hover:bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-normal transition-colors duration-200"
            disabled={loading}
          >
            New Chat
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 overflow-y-auto space-y-4">
        {messages.map((message, index) => (
          <ChatMessage key={index} message={message} />
        ))}
        {loading && !USE_STREAMING && !messages.some(m => m.isPendingTool) && (
          <div className="flex justify-start">
            <div className="bg-gray-300 text-gray-800 p-3 rounded-lg max-w-xs animate-pulse">
              Thinking...
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </main>

      <footer className="p-4 bg-white border-t flex items-center shadow-inner">
        <ChatInput
          input={input}
          setInput={setInput}
          sendMessage={sendMessage}
          handleKeyPress={handleKeyPress}
          loading={loading}
        />
      </footer>
    </div>
  );
}