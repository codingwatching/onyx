import React, { useCallback, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypePrism from "rehype-prism-plus";
import rehypeKatex from "rehype-katex";
import "prismjs/themes/prism-tomorrow.css";
import "katex/dist/katex.min.css";
import "../custom-code-styles.css";

import { ChatPacket, PacketType } from "../../services/streamingModels";
import { MessageRenderer, FullChatState } from "./interfaces";
import { MemoizedAnchor, MemoizedParagraph } from "../MemoizedTextComponents";
import { extractCodeText, preprocessLaTeX } from "../codeUtils";
import { CodeBlock } from "../CodeBlock";
import { transformLinkUri } from "@/lib/utils";

export const MessageTextRenderer: MessageRenderer<
  ChatPacket,
  FullChatState
> = ({ packets, state }: { packets: ChatPacket[]; state: FullChatState }) => {
  const content = packets
    .map((packet) => {
      if (
        packet.obj.type === PacketType.MESSAGE_DELTA ||
        packet.obj.type === PacketType.MESSAGE_START
      ) {
        return packet.obj.content;
      }
      return "";
    })
    .join("");

  console.log("packets", packets);

  // Check if the message is complete by looking for MESSAGE_END packet
  const isComplete = packets.some(
    (packet) => packet.obj.type === PacketType.MESSAGE_END
  );

  const processContent = (content: string) => {
    const codeBlockRegex = /```(\w*)\n[\s\S]*?```|```[\s\S]*?$/g;
    const matches = content.match(codeBlockRegex);

    if (matches) {
      content = matches.reduce((acc, match) => {
        if (!match.match(/```\w+/)) {
          return acc.replace(match, match.replace("```", "```plaintext"));
        }
        return acc;
      }, content);

      const lastMatch = matches[matches.length - 1];
      if (lastMatch && !lastMatch.endsWith("```")) {
        return preprocessLaTeX(content);
      }
    }

    const processed = preprocessLaTeX(content);

    // Add blinking dot indicator when message is not complete and has content, similar to the original AIMessage
    return processed + (!isComplete && processed.trim() ? " [*]() " : "");
  };

  const processedContent = processContent(content);

  const paragraphCallback = useCallback(
    (props: any) => <MemoizedParagraph>{props.children}</MemoizedParagraph>,
    []
  );

  const anchorCallback = useCallback(
    (props: any) => (
      <MemoizedAnchor
        updatePresentingDocument={state.setPresentingDocument || (() => {})}
        docs={state.docs || []}
        userFiles={state.userFiles || []}
        href={props.href}
      >
        {props.children}
      </MemoizedAnchor>
    ),
    [state.docs, state.userFiles, state.setPresentingDocument]
  );

  const markdownComponents = useMemo(
    () => ({
      a: anchorCallback,
      p: paragraphCallback,
      b: ({ node, className, children }: any) => {
        return <span className={className}>{children}</span>;
      },
      code: ({ node, className, children }: any) => {
        const codeText = extractCodeText(node, processedContent, children);

        return (
          <CodeBlock className={className} codeText={codeText}>
            {children}
          </CodeBlock>
        );
      },
    }),
    [anchorCallback, paragraphCallback, processedContent]
  );

  return (
    <ReactMarkdown
      className="prose dark:prose-invert max-w-full text-base"
      components={markdownComponents}
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypePrism, { ignoreMissing: true }], rehypeKatex]}
      urlTransform={transformLinkUri}
    >
      {processedContent}
    </ReactMarkdown>
  );
};
