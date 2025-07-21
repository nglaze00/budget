// src/components/ChatInput.tsx
import React from 'react';

interface ChatInputProps {
  input: string;
  setInput: (value: string) => void;
  sendMessage: () => void;
  handleKeyPress: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  loading: boolean;
}

const ChatInput: React.FC<ChatInputProps> = ({
  input,
  setInput,
  sendMessage,
  handleKeyPress,
  loading,
}) => {
  return (
    <div className="flex items-center w-full">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyPress={handleKeyPress}
        placeholder={loading ? "Thinking..." : "Type your message..."}
        className="flex-1 p-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-800"
        disabled={loading}
      />
      <button
        onClick={sendMessage}
        className="ml-4 px-6 py-3 bg-blue-800 text-white rounded-lg hover:bg-blue-950 focus:outline-none focus:ring-2 focus:ring-blue-500 transition duration-200 ease-in-out disabled:opacity-50 disabled:cursor-not-allowed"
        disabled={loading}
      >
        Send
      </button>
    </div>
  );
};

export default ChatInput;