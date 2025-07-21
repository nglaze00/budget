// src/components/ChatMessage.tsx
import 'highlight.js/styles/github.css'; // You can choose different themes
import React from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';

interface Message {
  user_message: string;
  sender: 'user' | 'ai';
  isPendingTool?: boolean;
  toolResult?: { status: string; message: string };
}

interface ChatMessageProps {
  message: Message;
}

// Helper function to get markdown components
const getMarkdownComponents = () => ({
  // Custom styling for code blocks
  pre: ({ children }: any) => (
    <pre className="bg-gray-100 p-2 rounded text-sm overflow-x-auto border">
      {children}
    </pre>
  ),
  // Custom styling for inline code
  code: ({ children }: any) => (
    <code className="bg-gray-100 px-1 rounded text-sm">
      {children}
    </code>
  ),
  // Custom image component to handle base64 plots
  img: ({ src, alt, ...props }: any) => {
    console.log('img component received:', { src, alt, props });
    console.log('src type:', typeof src);
    console.log('src length:', typeof src === 'string' ? src.length : 'N/A (Blob)');
    
    // Validate the image source
    if (!src || (typeof src === 'string' && (src.trim() === '' || src.includes('undefined') || src.includes('null')))) {
      console.log('Invalid src detected:', src);
      return (
        <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded my-2">
          ⚠️ Image could not be loaded (invalid source)
        </div>
      );
    }
    
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img 
        src={src} 
        alt={alt || 'Generated plot'} 
        className="max-w-full h-auto rounded border my-2"
        style={{ maxHeight: '500px' }}
        onError={(e) => {
          console.error('Image failed to load:', src);
          const target = e.currentTarget;
          target.style.display = 'none';
          if (target.parentElement && !target.parentElement.querySelector('.error-message')) {
            const errorDiv = document.createElement('div');
            errorDiv.className = 'bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded my-2 error-message';
            errorDiv.textContent = '⚠️ Image failed to load';
            target.parentElement.insertBefore(errorDiv, target);
          }
        }}
        {...props}
      />
    );
  },
  // Ensure proper styling for paragraphs and preserve text content
  p: ({ children }: any) => <p className="mb-2 last:mb-0">{children}</p>,
  // Ensure text nodes are properly rendered
  text: ({ children }: any) => <>{children}</>,
  // Custom styling for lists
  ul: ({ children }: any) => (
    <ul className="list-disc list-inside mb-2 space-y-1">
      {children}
    </ul>
  ),
  ol: ({ children }: any) => (
    <ol className="list-decimal list-inside mb-2 space-y-1">
      {children}
    </ol>
  ),
  li: ({ children }: any) => (
    <li className="text-gray-800">{children}</li>
  ),
  // Custom styling for tables
  table: ({ children }: any) => (
    <table className="border-collapse border-2 border-gray-600 mb-2 w-full bg-white">
      {children}
    </table>
  ),
  thead: ({ children }: any) => (
    <thead className="bg-gray-200">{children}</thead>
  ),
  tbody: ({ children }: any) => (
    <tbody>{children}</tbody>
  ),
  tr: ({ children }: any) => (
    <tr className="border-b border-gray-600">{children}</tr>
  ),
  th: ({ children }: any) => (
    <th className="border border-gray-600 px-3 py-2 text-left font-semibold text-gray-800 bg-gray-200">
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td className="border border-gray-600 px-3 py-2 text-gray-800 bg-white">
      {children}
    </td>
  ),
});

const ChatMessage: React.FC<ChatMessageProps> = ({ message }) => {
  const isUser = message.sender === 'user';

  // Debug plot markdown
  if (!isUser && message.user_message.includes('![Plot](data:image/png;base64,')) {
    console.log('Markdown contains plot:', message.user_message.substring(0, 200) + '...');
  }

  // Check if this message contains a plot and extract the base64 data
  const plotMatch = message.user_message.match(/!\[Plot\]\(data:image\/png;base64,([^)]+)\)/);

  // Dynamic styling based on sender and tool status
  const messageClasses = `
    p-3 rounded-lg max-w-[80%] break-words shadow-sm
    ${isUser ? 'bg-blue-500 text-white ml-auto' : 'bg-gray-300 text-gray-800 mr-auto'}
    ${message.isPendingTool ? 'bg-yellow-200 text-yellow-800 animate-pulse' : ''}
    ${message.toolResult?.status === 'error' ? 'bg-red-200 text-red-800' : ''}
  `;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className={messageClasses}>
        {isUser ? (
          // User messages: render as plain text with pre-wrap
          <div className="whitespace-pre-wrap">{message.user_message}</div>
        ) : (
          // AI messages: render as markdown
          <div className="prose prose-sm max-w-none prose-headings:text-gray-800 prose-p:text-gray-800 prose-strong:text-gray-800 prose-code:text-gray-800 prose-pre:bg-gray-100 prose-pre:text-gray-800 prose-ul:text-gray-800 prose-ol:text-gray-800 prose-li:text-gray-800">
            {plotMatch ? (
              // Special handling for plot messages
              <div>
                {/* Render the text part without the image markdown */}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  rehypePlugins={[rehypeHighlight]}
                  skipHtml={false}
                  components={getMarkdownComponents()}
                >
                  {message.user_message.replace(/!\[Plot\]\(data:image\/png;base64,[^)]+\)/, '')}
                </ReactMarkdown>
                {/* Render the plot image directly */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img 
                  src={`data:image/png;base64,${plotMatch[1]}`}
                  alt="Generated plot" 
                  className="max-w-full h-auto rounded border my-2"
                  style={{ maxHeight: '500px' }}
                  onError={(e) => {
                    console.error('Image failed to load');
                    e.currentTarget.style.display = 'none';
                  }}
                />
              </div>
            ) : (
              // Normal markdown rendering
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[rehypeHighlight]}
                skipHtml={false}
                components={getMarkdownComponents()}
              >
                {message.user_message}
              </ReactMarkdown>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChatMessage;