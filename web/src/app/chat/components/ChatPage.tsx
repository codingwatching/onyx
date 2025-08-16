"use client";

import { redirect, useRouter, useSearchParams } from "next/navigation";
import {
  ChatFileType,
  ChatSession,
  ChatSessionSharedStatus,
  FileDescriptor,
  Message,
} from "../interfaces";

import Cookies from "js-cookie";
import { HistorySidebar } from "@/components/sidebar/HistorySidebar";
import { Persona } from "../../admin/assistants/interfaces";
import { HealthCheckBanner } from "@/components/health/healthcheck";
import {
  getCitedDocumentsFromMessage,
  getHumanAndAIMessageFromMessageNumber,
  personaIncludesRetrieval,
  useScrollonStream,
} from "../services/lib";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePopup } from "@/components/admin/connectors/Popup";
import { SEARCH_PARAM_NAMES } from "../services/searchParams";
import { LlmDescriptor, useFilters, useLlmManager } from "@/lib/hooks";
import { FeedbackType } from "@/app/chat/interfaces";
import { OnyxInitializingLoader } from "@/components/OnyxInitializingLoader";
import { FeedbackModal } from "./modal/FeedbackModal";
import { ShareChatSessionModal } from "./modal/ShareChatSessionModal";
import { FiArrowDown } from "react-icons/fi";
import { ChatIntro } from "./ChatIntro";
import { AIMessage, HumanMessage } from "../message/Messages";
import { StarterMessages } from "../../../components/assistants/StarterMessage";
import { OnyxDocument, MinimalOnyxDocument } from "@/lib/search/interfaces";
import { SettingsContext } from "@/components/settings/SettingsProvider";
import Dropzone from "react-dropzone";
import { ChatInputBar } from "./input/ChatInputBar";
import { useChatContext } from "@/components/context/ChatContext";
import { ChatPopup } from "./ChatPopup";
import FunctionalHeader from "@/components/chat/Header";
import { useSidebarVisibility } from "@/components/chat/hooks";
import {
  PRO_SEARCH_TOGGLED_COOKIE_NAME,
  SIDEBAR_TOGGLED_COOKIE_NAME,
} from "@/components/resizable/constants";
import FixedLogo from "@/components/logo/FixedLogo";
import ExceptionTraceModal from "@/components/modals/ExceptionTraceModal";
import { SEARCH_TOOL_ID, SEARCH_TOOL_NAME } from "./tools/constants";
import { useUser } from "@/components/user/UserProvider";
import { ApiKeyModal } from "@/components/llm/ApiKeyModal";
import BlurBackground from "../../../components/chat/BlurBackground";
import { NoAssistantModal } from "@/components/modals/NoAssistantModal";
import { useAssistantsContext } from "@/components/context/AssistantsContext";
import TextView from "@/components/chat/TextView";
import { Modal } from "@/components/Modal";
import { useSendMessageToParent } from "@/lib/extension/utils";
import {
  CHROME_MESSAGE,
  SUBMIT_MESSAGE_TYPES,
} from "@/lib/extension/constants";

import { getSourceMetadata } from "@/lib/sources";
import { UserSettingsModal } from "./modal/UserSettingsModal";
import { AgenticMessage } from "../message/AgenticMessage";
import AssistantModal from "../../assistants/mine/AssistantModal";
import { useSidebarShortcut } from "@/lib/browserUtilities";
import { FilePickerModal } from "../my-documents/components/FilePicker";

import { SourceMetadata } from "@/lib/search/interfaces";
import { ValidSources } from "@/lib/types";
import { useDocumentsContext } from "../my-documents/DocumentsContext";
import { ChatSearchModal } from "../chat_search/ChatSearchModal";
import { ErrorBanner } from "../message/Resubmit";
import MinimalMarkdown from "@/components/chat/MinimalMarkdown";
import { useScreenSize } from "@/hooks/useScreenSize";
import { DocumentResults } from "./documentSidebar/DocumentResults";
import { getLatestMessageChain } from "../services/messageTree";
import { useChatController } from "../hooks/useChatController";
import { useAssistantController } from "../hooks/useAssistantController";
import { useChatSessionController } from "../hooks/useChatSessionController";
import {
  useChatSessionStore,
  useMaxTokens,
} from "../stores/useChatSessionStore";
import {
  useCurrentChatState,
  useCurrentRegenerationState,
  useSubmittedMessage,
  useCanContinue,
  useAgenticGenerating,
  useUncaughtError,
  useLoadingError,
  useIsReady,
  useIsFetching,
  useCurrentMessageTree,
  useCurrentMessageHistory,
  useHasPerformedInitialScroll,
  useDocumentSidebarVisible,
  useSelectedMessageForDocDisplay,
  useChatSessionSharedStatus,
  useHasSentLocalUserMessage,
} from "../stores/useChatSessionStore";

export enum UploadIntent {
  ATTACH_TO_MESSAGE, // For files uploaded via ChatInputBar (paste, drag/drop)
  ADD_TO_DOCUMENTS, // For files uploaded via FilePickerModal or similar (just add to repo)
}

export function ChatPage({
  toggle,
  documentSidebarInitialWidth,
  sidebarVisible,
  firstMessage,
}: {
  toggle: (toggled?: boolean) => void;
  documentSidebarInitialWidth?: number;
  sidebarVisible: boolean;
  firstMessage?: string;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const {
    chatSessions,
    ccPairs,
    tags,
    documentSets,
    llmProviders,
    folders,
    shouldShowWelcomeModal,
    proSearchToggled,
    refreshChatSessions,
  } = useChatContext();

  const {
    selectedFiles,
    selectedFolders,
    addSelectedFolder,
    clearSelectedItems,
    folders: userFolders,
    files: allUserFiles,
    currentMessageFiles,
    setCurrentMessageFiles,
  } = useDocumentsContext();

  const { height: screenHeight } = useScreenSize();

  // handle redirect if chat page is disabled
  // NOTE: this must be done here, in a client component since
  // settings are passed in via Context and therefore aren't
  // available in server-side components
  const settings = useContext(SettingsContext);
  const enterpriseSettings = settings?.enterpriseSettings;

  const [toggleDocSelection, setToggleDocSelection] = useState(false);
  const [proSearchEnabled, setProSearchEnabled] = useState(proSearchToggled);
  const toggleProSearch = () => {
    Cookies.set(
      PRO_SEARCH_TOGGLED_COOKIE_NAME,
      String(!proSearchEnabled).toLocaleLowerCase()
    );
    setProSearchEnabled(!proSearchEnabled);
  };

  const isInitialLoad = useRef(true);
  const [userSettingsToggled, setUserSettingsToggled] = useState(false);

  const { assistants: availableAssistants } = useAssistantsContext();

  const [showApiKeyModal, setShowApiKeyModal] = useState(
    !shouldShowWelcomeModal
  );

  const { user, isAdmin } = useUser();
  const existingChatIdRaw = searchParams?.get("chatId");

  const [showHistorySidebar, setShowHistorySidebar] = useState(false);

  const existingChatSessionId = existingChatIdRaw ? existingChatIdRaw : null;

  const selectedChatSession = chatSessions.find(
    (chatSession) => chatSession.id === existingChatSessionId
  );

  const processSearchParamsAndSubmitMessage = (searchParamsString: string) => {
    const newSearchParams = new URLSearchParams(searchParamsString);
    const message = newSearchParams?.get("user-prompt");

    filterManager.buildFiltersFromQueryString(
      newSearchParams.toString(),
      availableSources,
      documentSets.map((ds) => ds.name),
      tags
    );

    const fileDescriptorString = newSearchParams?.get(SEARCH_PARAM_NAMES.FILES);
    const overrideFileDescriptors: FileDescriptor[] = fileDescriptorString
      ? JSON.parse(decodeURIComponent(fileDescriptorString))
      : [];

    newSearchParams.delete(SEARCH_PARAM_NAMES.SEND_ON_LOAD);

    router.replace(`?${newSearchParams.toString()}`, { scroll: false });

    // If there's a message, submit it
    if (message) {
      onSubmit({
        message,
        selectedFiles,
        selectedFolders,
        currentMessageFiles,
        useAgentSearch: proSearchEnabled,
      });
    }
  };

  const {
    selectedAssistant,
    setSelectedAssistantFromId,
    alternativeAssistant,
    setAlternativeAssistant,
    liveAssistant,
  } = useAssistantController({
    selectedChatSession,
  });

  const [presentingDocument, setPresentingDocument] =
    useState<MinimalOnyxDocument | null>(null);

  const llmManager = useLlmManager(
    llmProviders,
    selectedChatSession,
    liveAssistant
  );

  const noAssistants = liveAssistant === null || liveAssistant === undefined;

  const availableSources: ValidSources[] = useMemo(() => {
    return ccPairs.map((ccPair) => ccPair.source);
  }, [ccPairs]);

  const sources: SourceMetadata[] = useMemo(() => {
    const uniqueSources = Array.from(new Set(availableSources));
    return uniqueSources.map((source) => getSourceMetadata(source));
  }, [availableSources]);

  const { popup, setPopup } = usePopup();

  useEffect(() => {
    const userFolderId = searchParams?.get(SEARCH_PARAM_NAMES.USER_FOLDER_ID);
    const allMyDocuments = searchParams?.get(
      SEARCH_PARAM_NAMES.ALL_MY_DOCUMENTS
    );

    if (userFolderId) {
      const userFolder = userFolders.find(
        (folder) => folder.id === parseInt(userFolderId)
      );
      if (userFolder) {
        addSelectedFolder(userFolder);
      }
    } else if (allMyDocuments === "true" || allMyDocuments === "1") {
      // Clear any previously selected folders

      clearSelectedItems();

      // Add all user folders to the current context
      userFolders.forEach((folder) => {
        addSelectedFolder(folder);
      });
    }
  }, [
    userFolders,
    searchParams?.get(SEARCH_PARAM_NAMES.USER_FOLDER_ID),
    searchParams?.get(SEARCH_PARAM_NAMES.ALL_MY_DOCUMENTS),
    addSelectedFolder,
    clearSelectedItems,
  ]);

  const [message, setMessage] = useState(
    searchParams?.get(SEARCH_PARAM_NAMES.USER_PROMPT) || ""
  );

  const filterManager = useFilters();
  const [isChatSearchModalOpen, setIsChatSearchModalOpen] = useState(false);

  const [currentFeedback, setCurrentFeedback] = useState<
    [FeedbackType, number] | null
  >(null);

  const [sharingModalVisible, setSharingModalVisible] =
    useState<boolean>(false);

  const [aboveHorizon, setAboveHorizon] = useState(false);

  const scrollableDivRef = useRef<HTMLDivElement>(null);
  const lastMessageRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const endDivRef = useRef<HTMLDivElement>(null);
  const endPaddingRef = useRef<HTMLDivElement>(null);

  const scrollInitialized = useRef(false);

  const previousHeight = useRef<number>(
    inputRef.current?.getBoundingClientRect().height!
  );
  const scrollDist = useRef<number>(0);

  const handleInputResize = () => {
    setTimeout(() => {
      if (
        inputRef.current &&
        lastMessageRef.current &&
        !waitForScrollRef.current
      ) {
        const newHeight: number =
          inputRef.current?.getBoundingClientRect().height!;
        const heightDifference = newHeight - previousHeight.current;
        if (
          previousHeight.current &&
          heightDifference != 0 &&
          endPaddingRef.current &&
          scrollableDivRef &&
          scrollableDivRef.current
        ) {
          endPaddingRef.current.style.transition = "height 0.3s ease-out";
          endPaddingRef.current.style.height = `${Math.max(
            newHeight - 50,
            0
          )}px`;

          if (autoScrollEnabled) {
            scrollableDivRef?.current.scrollBy({
              left: 0,
              top: Math.max(heightDifference, 0),
              behavior: "smooth",
            });
          }
        }
        previousHeight.current = newHeight;
      }
    }, 100);
  };

  const resetInputBar = () => {
    setMessage("");
    setCurrentMessageFiles([]);
    if (endPaddingRef.current) {
      endPaddingRef.current.style.height = `95px`;
    }
  };

  const clientScrollToBottom = (fast?: boolean) => {
    waitForScrollRef.current = true;

    setTimeout(() => {
      if (!endDivRef.current || !scrollableDivRef.current) {
        console.error("endDivRef or scrollableDivRef not found");
        return;
      }

      const rect = endDivRef.current.getBoundingClientRect();
      const isVisible = rect.top >= 0 && rect.bottom <= window.innerHeight;

      if (isVisible) return;

      // Check if all messages are currently rendered
      // If all messages are already rendered, scroll immediately
      endDivRef.current.scrollIntoView({
        behavior: fast ? "auto" : "smooth",
      });

      if (chatSessionIdRef.current) {
        updateHasPerformedInitialScroll(chatSessionIdRef.current, true);
      }
    }, 50);

    // Reset waitForScrollRef after 1.5 seconds
    setTimeout(() => {
      waitForScrollRef.current = false;
    }, 1500);
  };

  const debounceNumber = 100; // time for debouncing

  // handle re-sizing of the text area
  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    handleInputResize();
  }, [message]);

  // Add refs needed by useChatSessionController
  const chatSessionIdRef = useRef<string | null>(existingChatSessionId);
  const loadedIdSessionRef = useRef<string | null>(existingChatSessionId);
  const submitOnLoadPerformed = useRef<boolean>(false);

  // used for resizing of the document sidebar
  const masterFlexboxRef = useRef<HTMLDivElement>(null);
  const [maxDocumentSidebarWidth, setMaxDocumentSidebarWidth] = useState<
    number | null
  >(null);
  const adjustDocumentSidebarWidth = () => {
    if (masterFlexboxRef.current && document.documentElement.clientWidth) {
      // numbers below are based on the actual width the center section for different
      // screen sizes. `1700` corresponds to the custom "3xl" tailwind breakpoint
      // NOTE: some buffer is needed to account for scroll bars
      if (document.documentElement.clientWidth > 1700) {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 950);
      } else if (document.documentElement.clientWidth > 1420) {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 760);
      } else {
        setMaxDocumentSidebarWidth(masterFlexboxRef.current.clientWidth - 660);
      }
    }
  };

  const loadNewPageLogic = (event: MessageEvent) => {
    if (event.data.type === SUBMIT_MESSAGE_TYPES.PAGE_CHANGE) {
      try {
        const url = new URL(event.data.href);
        processSearchParamsAndSubmitMessage(url.searchParams.toString());
      } catch (error) {
        console.error("Error parsing URL:", error);
      }
    }
  };

  // Equivalent to `loadNewPageLogic`
  useEffect(() => {
    if (searchParams?.get(SEARCH_PARAM_NAMES.SEND_ON_LOAD)) {
      processSearchParamsAndSubmitMessage(searchParams.toString());
    }
  }, [searchParams, router]);

  useEffect(() => {
    adjustDocumentSidebarWidth();
    window.addEventListener("resize", adjustDocumentSidebarWidth);
    window.addEventListener("message", loadNewPageLogic);

    return () => {
      window.removeEventListener("message", loadNewPageLogic);
      window.removeEventListener("resize", adjustDocumentSidebarWidth);
    };
  }, []);

  if (!documentSidebarInitialWidth && maxDocumentSidebarWidth) {
    documentSidebarInitialWidth = Math.min(700, maxDocumentSidebarWidth);
  }

  const continueGenerating = () => {
    onSubmit({
      message: "Continue Generating (pick up exactly where you left off)",
      selectedFiles: [],
      selectedFolders: [],
      currentMessageFiles: [],
      useAgentSearch: proSearchEnabled,
    });
  };

  const [selectedDocuments, setSelectedDocuments] = useState<OnyxDocument[]>(
    []
  );

  // Access chat state directly from the store
  const currentChatState = useCurrentChatState();
  const currentRegenerationState = useCurrentRegenerationState();
  const chatSessionId = useChatSessionStore((state) => state.currentSessionId);
  const submittedMessage = useSubmittedMessage();
  const canContinue = useCanContinue();
  const agenticGenerating = useAgenticGenerating();
  const uncaughtError = useUncaughtError();
  const loadingError = useLoadingError();
  const isReady = useIsReady();
  const maxTokens = useMaxTokens();
  const isFetchingChatMessages = useIsFetching();
  const completeMessageTree = useCurrentMessageTree();
  const messageHistory = useCurrentMessageHistory();
  const hasPerformedInitialScroll = useHasPerformedInitialScroll();
  const currentSessionHasSentLocalUserMessage = useHasSentLocalUserMessage();
  const documentSidebarVisible = useDocumentSidebarVisible();
  const selectedMessageForDocDisplay = useSelectedMessageForDocDisplay();
  const chatSessionSharedStatus = useChatSessionSharedStatus();
  const updateHasPerformedInitialScroll = useChatSessionStore(
    (state) => state.updateHasPerformedInitialScroll
  );
  const updateCurrentDocumentSidebarVisible = useChatSessionStore(
    (state) => state.updateCurrentDocumentSidebarVisible
  );
  const updateCurrentSelectedMessageForDocDisplay = useChatSessionStore(
    (state) => state.updateCurrentSelectedMessageForDocDisplay
  );
  const updateCurrentChatSessionSharedStatus = useChatSessionStore(
    (state) => state.updateCurrentChatSessionSharedStatus
  );

  const { onSubmit, stopGenerating, handleMessageSpecificFileUpload } =
    useChatController({
      filterManager,
      llmManager,
      availableAssistants,
      liveAssistant,
      existingChatSessionId,
      selectedDocuments,
      searchParams,
      setPopup,
      clientScrollToBottom,
      resetInputBar,
      setSelectedAssistantFromId,
      setSelectedMessageForDocDisplay:
        updateCurrentSelectedMessageForDocDisplay,
    });

  const { onMessageSelection } = useChatSessionController({
    existingChatSessionId,
    searchParams,
    filterManager,
    firstMessage,
    setSelectedAssistantFromId,
    setSelectedDocuments,
    setCurrentMessageFiles,
    chatSessionIdRef,
    loadedIdSessionRef,
    textAreaRef,
    scrollInitialized,
    isInitialLoad,
    submitOnLoadPerformed,
    hasPerformedInitialScroll,
    clientScrollToBottom,
    clearSelectedItems,
    refreshChatSessions,
    onSubmit,
  });

  const autoScrollEnabled =
    (user?.preferences?.auto_scroll && !agenticGenerating) ?? false;

  useScrollonStream({
    chatState: currentChatState,
    scrollableDivRef,
    scrollDist,
    endDivRef,
    debounceNumber,
    mobile: settings?.isMobile,
    enableAutoScroll: autoScrollEnabled,
  });

  const getContainerHeight = useMemo(() => {
    return () => {
      if (!currentSessionHasSentLocalUserMessage) {
        return undefined;
      }
      if (autoScrollEnabled) return undefined;

      if (screenHeight < 600) return "40vh";
      if (screenHeight < 1200) return "50vh";
      return "60vh";
    };
  }, [autoScrollEnabled, screenHeight, currentSessionHasSentLocalUserMessage]);

  const reset = () => {
    setMessage("");
    setCurrentMessageFiles([]);
    clearSelectedItems();
    // TODO: move this into useChatController
    // setLoadingError(null);
  };

  // Used to maintain a "time out" for history sidebar so our existing refs can have time to process change
  const [untoggled, setUntoggled] = useState(false);

  const explicitlyUntoggle = () => {
    setShowHistorySidebar(false);

    setUntoggled(true);
    setTimeout(() => {
      setUntoggled(false);
    }, 200);
  };
  const toggleSidebar = () => {
    if (user?.is_anonymous_user) {
      return;
    }
    Cookies.set(
      SIDEBAR_TOGGLED_COOKIE_NAME,
      String(!sidebarVisible).toLocaleLowerCase()
    );

    toggle();
  };
  const removeToggle = () => {
    setShowHistorySidebar(false);
    toggle(false);
  };

  const waitForScrollRef = useRef(false);
  const sidebarElementRef = useRef<HTMLDivElement>(null);

  useSidebarVisibility({
    sidebarVisible,
    sidebarElementRef,
    showDocSidebar: showHistorySidebar,
    setShowDocSidebar: setShowHistorySidebar,
    setToggled: removeToggle,
    mobile: settings?.isMobile,
    isAnonymousUser: user?.is_anonymous_user,
  });

  useSendMessageToParent();

  const retrievalEnabled = useMemo(() => {
    if (liveAssistant) {
      return liveAssistant.tools.some(
        (tool) =>
          tool.in_code_tool_id === SEARCH_TOOL_ID &&
          liveAssistant.user_file_ids?.length == 0 &&
          liveAssistant.user_folder_ids?.length == 0
      );
    }
    return false;
  }, [liveAssistant]);

  useEffect(() => {
    if (
      (!personaIncludesRetrieval &&
        (!selectedDocuments || selectedDocuments.length === 0) &&
        documentSidebarVisible) ||
      chatSessionId == undefined
    ) {
      updateCurrentDocumentSidebarVisible(false);
    }
    clientScrollToBottom();
  }, [chatSessionId]);

  useEffect(() => {
    if (
      submittedMessage &&
      currentChatState === "loading" &&
      messageHistory.length == 0
    ) {
      window.parent.postMessage(
        { type: CHROME_MESSAGE.LOAD_NEW_CHAT_PAGE },
        "*"
      );
    }
  }, [submittedMessage, chatSessionId]);

  const [stackTraceModalContent, setStackTraceModalContent] = useState<
    string | null
  >(null);

  const innerSidebarElementRef = useRef<HTMLDivElement>(null);
  const [settingsToggled, setSettingsToggled] = useState(false);

  const HORIZON_DISTANCE = 800;
  const handleScroll = useCallback(() => {
    const scrollDistance =
      endDivRef?.current?.getBoundingClientRect()?.top! -
      inputRef?.current?.getBoundingClientRect()?.top!;
    scrollDist.current = scrollDistance;
    setAboveHorizon(scrollDist.current > HORIZON_DISTANCE);
  }, []);

  useSidebarShortcut(router, toggleSidebar);

  const [sharedChatSession, setSharedChatSession] =
    useState<ChatSession | null>();

  const handleResubmitLastMessage = () => {
    // Grab the last user-type message
    const lastUserMsg = messageHistory
      .slice()
      .reverse()
      .find((m) => m.type === "user");
    if (!lastUserMsg) {
      setPopup({
        message: "No previously-submitted user message found.",
        type: "error",
      });
      return;
    }

    // We call onSubmit, passing a `messageOverride`
    onSubmit({
      message: lastUserMsg.message,
      selectedFiles: selectedFiles,
      selectedFolders: selectedFolders,
      currentMessageFiles: currentMessageFiles,
      useAgentSearch: proSearchEnabled,
      messageIdToResend: lastUserMsg.messageId,
    });
  };

  const [showAssistantsModal, setShowAssistantsModal] = useState(false);

  const toggleDocumentSidebar = () => {
    if (!documentSidebarVisible) {
      updateCurrentDocumentSidebarVisible(true);
    } else {
      updateCurrentDocumentSidebarVisible(false);
    }
  };

  interface RegenerationRequest {
    messageId: number;
    parentMessage: Message;
    forceSearch?: boolean;
  }

  function createRegenerator(regenerationRequest: RegenerationRequest) {
    // Returns new function that only needs `modelOveride` to be specified when called
    return async function (modelOverride: LlmDescriptor) {
      return await onSubmit({
        message: message,
        selectedFiles: selectedFiles,
        selectedFolders: selectedFolders,
        currentMessageFiles: currentMessageFiles,
        useAgentSearch: proSearchEnabled,
        modelOverride,
        messageIdToResend: regenerationRequest.parentMessage.messageId,
        regenerationRequest,
        forceSearch: regenerationRequest.forceSearch,
      });
    };
  }
  if (!user) {
    redirect("/auth/login");
  }

  if (noAssistants)
    return (
      <>
        <HealthCheckBanner />
        <NoAssistantModal isAdmin={isAdmin} />
      </>
    );

  const clearSelectedDocuments = () => {
    setSelectedDocuments([]);
    clearSelectedItems();
  };

  const toggleDocumentSelection = (document: OnyxDocument) => {
    setSelectedDocuments((prev) =>
      prev.some((d) => d.document_id === document.document_id)
        ? prev.filter((d) => d.document_id !== document.document_id)
        : [...prev, document]
    );
  };

  const { aiMessage, humanMessage } = selectedMessageForDocDisplay
    ? getHumanAndAIMessageFromMessageNumber(
        messageHistory,
        selectedMessageForDocDisplay
      )
    : { aiMessage: null, humanMessage: null };

  return (
    <>
      <HealthCheckBanner />

      {showApiKeyModal && !shouldShowWelcomeModal && (
        <ApiKeyModal
          hide={() => setShowApiKeyModal(false)}
          setPopup={setPopup}
        />
      )}

      {/* ChatPopup is a custom popup that displays a admin-specified message on initial user visit. 
      Only used in the EE version of the app. */}
      {popup}

      <ChatPopup />

      {currentFeedback && (
        <FeedbackModal
          feedbackType={currentFeedback[0]}
          messageId={currentFeedback[1]}
          onClose={() => setCurrentFeedback(null)}
          setPopup={setPopup}
        />
      )}

      {(settingsToggled || userSettingsToggled) && (
        <UserSettingsModal
          setPopup={setPopup}
          setCurrentLlm={(newLlm) => llmManager.updateCurrentLlm(newLlm)}
          defaultModel={user?.preferences.default_model!}
          llmProviders={llmProviders}
          onClose={() => {
            setUserSettingsToggled(false);
            setSettingsToggled(false);
          }}
        />
      )}

      {toggleDocSelection && (
        <FilePickerModal
          setPresentingDocument={setPresentingDocument}
          buttonContent="Set as Context"
          isOpen={true}
          onClose={() => setToggleDocSelection(false)}
          onSave={() => {
            setToggleDocSelection(false);
          }}
        />
      )}

      <ChatSearchModal
        open={isChatSearchModalOpen}
        onCloseModal={() => setIsChatSearchModalOpen(false)}
      />

      {retrievalEnabled && documentSidebarVisible && settings?.isMobile && (
        <div className="md:hidden">
          <Modal
            hideDividerForTitle
            onOutsideClick={() => updateCurrentDocumentSidebarVisible(false)}
            title="Sources"
          >
            <DocumentResults
              agenticMessage={
                aiMessage?.sub_questions?.length! > 0 ||
                messageHistory.find(
                  (m) => m.messageId === aiMessage?.parentMessageId
                )?.sub_questions?.length! > 0
                  ? true
                  : false
              }
              humanMessage={humanMessage ?? null}
              setPresentingDocument={setPresentingDocument}
              modal={true}
              ref={innerSidebarElementRef}
              closeSidebar={() => updateCurrentDocumentSidebarVisible(false)}
              selectedMessage={aiMessage ?? null}
              selectedDocuments={selectedDocuments}
              toggleDocumentSelection={toggleDocumentSelection}
              clearSelectedDocuments={clearSelectedDocuments}
              // TODO (chris): fix
              selectedDocumentTokens={0}
              maxTokens={maxTokens}
              initialWidth={400}
              isOpen={true}
              removeHeader
            />
          </Modal>
        </div>
      )}

      {presentingDocument && (
        <TextView
          presentingDocument={presentingDocument}
          onClose={() => setPresentingDocument(null)}
        />
      )}

      {stackTraceModalContent && (
        <ExceptionTraceModal
          onOutsideClick={() => setStackTraceModalContent(null)}
          exceptionTrace={stackTraceModalContent}
        />
      )}

      {sharedChatSession && (
        <ShareChatSessionModal
          assistantId={liveAssistant?.id}
          message={message}
          modelOverride={llmManager.currentLlm}
          chatSessionId={sharedChatSession.id}
          existingSharedStatus={sharedChatSession.shared_status}
          onClose={() => setSharedChatSession(null)}
          onShare={(shared) =>
            updateCurrentChatSessionSharedStatus(
              shared
                ? ChatSessionSharedStatus.Public
                : ChatSessionSharedStatus.Private
            )
          }
        />
      )}

      {sharingModalVisible && chatSessionId !== null && (
        <ShareChatSessionModal
          message={message}
          assistantId={liveAssistant?.id}
          modelOverride={llmManager.currentLlm}
          chatSessionId={chatSessionId}
          existingSharedStatus={chatSessionSharedStatus}
          onClose={() => setSharingModalVisible(false)}
        />
      )}

      {showAssistantsModal && (
        <AssistantModal hideModal={() => setShowAssistantsModal(false)} />
      )}

      <div className="fixed inset-0 flex flex-col text-text-dark">
        <div className="h-[100dvh] overflow-y-hidden">
          <div className="w-full">
            <div
              ref={sidebarElementRef}
              className={`
                flex-none
                fixed
                left-0
                z-40
                bg-neutral-200
                h-screen
                transition-all
                bg-opacity-80
                duration-300
                ease-in-out
                ${
                  !untoggled && (showHistorySidebar || sidebarVisible)
                    ? "opacity-100 w-[250px] translate-x-0"
                    : "opacity-0 w-[250px] pointer-events-none -translate-x-10"
                }`}
            >
              <div className="w-full relative">
                <HistorySidebar
                  toggleChatSessionSearchModal={() =>
                    setIsChatSearchModalOpen((open) => !open)
                  }
                  liveAssistant={liveAssistant}
                  setShowAssistantsModal={setShowAssistantsModal}
                  explicitlyUntoggle={explicitlyUntoggle}
                  reset={reset}
                  page="chat"
                  ref={innerSidebarElementRef}
                  toggleSidebar={toggleSidebar}
                  toggled={sidebarVisible}
                  existingChats={chatSessions}
                  currentChatSession={selectedChatSession}
                  folders={folders}
                  removeToggle={removeToggle}
                  showShareModal={setSharedChatSession}
                />
              </div>

              <div
                className={`
                flex-none
                fixed
                left-0
                z-40
                bg-background-100
                h-screen
                transition-all
                bg-opacity-80
                duration-300
                ease-in-out
                ${
                  documentSidebarVisible &&
                  !settings?.isMobile &&
                  "opacity-100 w-[350px]"
                }`}
              ></div>
            </div>
          </div>

          <div
            style={{ transition: "width 0.30s ease-out" }}
            className={`
                flex-none 
                fixed
                right-0
                z-[1000]
                h-screen
                transition-all
                duration-300
                ease-in-out
                bg-transparent
                transition-all
                duration-300
                ease-in-out
                h-full
                ${
                  documentSidebarVisible && !settings?.isMobile
                    ? "w-[400px]"
                    : "w-[0px]"
                }
            `}
          >
            <DocumentResults
              humanMessage={humanMessage ?? null}
              agenticMessage={
                aiMessage?.sub_questions?.length! > 0 ||
                messageHistory.find(
                  (m) => m.messageId === aiMessage?.parentMessageId
                )?.sub_questions?.length! > 0
                  ? true
                  : false
              }
              setPresentingDocument={setPresentingDocument}
              modal={false}
              ref={innerSidebarElementRef}
              closeSidebar={() =>
                setTimeout(
                  () => updateCurrentDocumentSidebarVisible(false),
                  300
                )
              }
              selectedMessage={aiMessage ?? null}
              selectedDocuments={selectedDocuments}
              toggleDocumentSelection={toggleDocumentSelection}
              clearSelectedDocuments={clearSelectedDocuments}
              // TODO (chris): fix
              selectedDocumentTokens={0}
              maxTokens={maxTokens}
              initialWidth={400}
              isOpen={documentSidebarVisible && !settings?.isMobile}
            />
          </div>

          <BlurBackground
            visible={!untoggled && (showHistorySidebar || sidebarVisible)}
            onClick={() => toggleSidebar()}
          />

          <div
            ref={masterFlexboxRef}
            className="flex h-full w-full overflow-x-hidden"
          >
            <div
              id="scrollableContainer"
              className="flex h-full relative px-2 flex-col w-full"
            >
              {liveAssistant && (
                <FunctionalHeader
                  toggleUserSettings={() => setUserSettingsToggled(true)}
                  sidebarToggled={sidebarVisible}
                  reset={() => setMessage("")}
                  page="chat"
                  setSharingModalVisible={
                    chatSessionId !== null ? setSharingModalVisible : undefined
                  }
                  documentSidebarVisible={
                    documentSidebarVisible && !settings?.isMobile
                  }
                  toggleSidebar={toggleSidebar}
                  currentChatSession={selectedChatSession}
                  hideUserDropdown={user?.is_anonymous_user}
                />
              )}

              {documentSidebarInitialWidth !== undefined && isReady ? (
                <Dropzone
                  key={chatSessionId}
                  onDrop={(acceptedFiles) =>
                    handleMessageSpecificFileUpload(acceptedFiles)
                  }
                  noClick
                >
                  {({ getRootProps }) => (
                    <div className="flex h-full w-full">
                      {!settings?.isMobile && (
                        <div
                          style={{ transition: "width 0.30s ease-out" }}
                          className={`
                          flex-none 
                          overflow-y-hidden 
                          bg-transparent
                          transition-all 
                          bg-opacity-80
                          duration-300 
                          ease-in-out
                          h-full
                          ${sidebarVisible ? "w-[200px]" : "w-[0px]"}
                      `}
                        ></div>
                      )}

                      <div
                        className={`h-full w-full relative flex-auto transition-margin duration-300 overflow-x-auto mobile:pb-12 desktop:pb-[100px]`}
                        {...getRootProps()}
                      >
                        <div
                          onScroll={handleScroll}
                          className={`w-full h-[calc(100vh-160px)] flex flex-col default-scrollbar overflow-y-auto overflow-x-hidden relative`}
                          ref={scrollableDivRef}
                        >
                          {liveAssistant && (
                            <div className="z-20 fixed top-0 pointer-events-none left-0 w-full flex justify-center overflow-visible">
                              {!settings?.isMobile && (
                                <div
                                  style={{ transition: "width 0.30s ease-out" }}
                                  className={`
                                  flex-none 
                                  overflow-y-hidden 
                                  transition-all 
                                  pointer-events-none
                                  duration-300 
                                  ease-in-out
                                  h-full
                                  ${sidebarVisible ? "w-[200px]" : "w-[0px]"}
                              `}
                                />
                              )}
                            </div>
                          )}
                          {/* ChatBanner is a custom banner that displays a admin-specified message at 
                      the top of the chat page. Oly used in the EE version of the app. */}
                          {messageHistory.length === 0 &&
                            !isFetchingChatMessages &&
                            currentChatState == "input" &&
                            !loadingError &&
                            !submittedMessage && (
                              <div className="h-full w-[95%] mx-auto flex flex-col justify-center items-center">
                                <ChatIntro selectedPersona={liveAssistant} />

                                <StarterMessages
                                  currentPersona={liveAssistant}
                                  onSubmit={(messageOverride) =>
                                    onSubmit({
                                      message: messageOverride,
                                      selectedFiles: selectedFiles,
                                      selectedFolders: selectedFolders,
                                      currentMessageFiles: currentMessageFiles,
                                      useAgentSearch: proSearchEnabled,
                                    })
                                  }
                                />
                              </div>
                            )}
                          <div
                            style={{ overflowAnchor: "none" }}
                            key={chatSessionId}
                            className={
                              (hasPerformedInitialScroll ? "" : " hidden ") +
                              "desktop:-ml-4 w-full mx-auto " +
                              "absolute mobile:top-0 desktop:top-0 left-0 " +
                              (settings?.enterpriseSettings
                                ?.two_lines_for_chat_header
                                ? "pt-20 "
                                : "pt-4 ")
                            }
                            // NOTE: temporarily removing this to fix the scroll bug
                            // (hasPerformedInitialScroll ? "" : "invisible")
                          >
                            {messageHistory.map((message, i) => {
                              const messageTree = completeMessageTree;

                              if (
                                currentRegenerationState?.finalMessageIndex &&
                                currentRegenerationState?.finalMessageIndex! <
                                  message.messageId
                              ) {
                                return <></>;
                              }

                              const messageReactComponentKey = `${i}-${chatSessionId}`;
                              const parentMessage = message.parentMessageId
                                ? messageTree?.get(message.parentMessageId)
                                : null;
                              if (message.type === "user") {
                                if (
                                  (currentChatState == "loading" &&
                                    i == messageHistory.length - 1) ||
                                  (currentRegenerationState?.regenerating &&
                                    message.messageId >=
                                      currentRegenerationState?.finalMessageIndex!)
                                ) {
                                  return <></>;
                                }
                                const nextMessage =
                                  messageHistory.length > i + 1
                                    ? messageHistory[i + 1]
                                    : null;
                                return (
                                  <div
                                    id={`message-${message.messageId}`}
                                    key={messageReactComponentKey}
                                  >
                                    <HumanMessage
                                      setPresentingDocument={
                                        setPresentingDocument
                                      }
                                      disableSwitchingForStreaming={
                                        (nextMessage &&
                                          nextMessage.is_generating) ||
                                        false
                                      }
                                      stopGenerating={stopGenerating}
                                      content={message.message}
                                      files={message.files}
                                      messageId={message.messageId}
                                      onEdit={(editedContent) => {
                                        onSubmit({
                                          message: editedContent,
                                          messageIdToResend:
                                            message.messageId || undefined,
                                          // TODO: fix
                                          selectedFiles: [],
                                          selectedFolders: [],
                                          currentMessageFiles: [],
                                          useAgentSearch: proSearchEnabled,
                                        });
                                      }}
                                      otherMessagesCanSwitchTo={
                                        parentMessage?.childrenMessageIds || []
                                      }
                                      onMessageSelection={onMessageSelection}
                                    />
                                  </div>
                                );
                              } else if (message.type === "assistant") {
                                const previousMessage =
                                  i !== 0 ? messageHistory[i - 1] : null;

                                const currentAlternativeAssistant =
                                  message.alternateAssistantID != null
                                    ? availableAssistants.find(
                                        (persona) =>
                                          persona.id ==
                                          message.alternateAssistantID
                                      )
                                    : null;

                                if (
                                  (currentChatState == "loading" &&
                                    i > messageHistory.length - 1) ||
                                  (currentRegenerationState?.regenerating &&
                                    message.messageId >
                                      currentRegenerationState?.finalMessageIndex!)
                                ) {
                                  return <></>;
                                }
                                if (parentMessage?.type == "assistant") {
                                  return <></>;
                                }
                                const secondLevelMessage =
                                  messageHistory[i + 1]?.type === "assistant"
                                    ? messageHistory[i + 1]
                                    : undefined;

                                const secondLevelAssistantMessage =
                                  messageHistory[i + 1]?.type === "assistant"
                                    ? messageHistory[i + 1]?.message
                                    : undefined;

                                const agenticDocs =
                                  messageHistory[i + 1]?.type === "assistant"
                                    ? messageHistory[i + 1]?.documents
                                    : undefined;

                                const nextMessage =
                                  messageHistory[i + 1]?.type === "assistant"
                                    ? messageHistory[i + 1]
                                    : undefined;

                                const attachedFileDescriptors =
                                  previousMessage?.files.filter(
                                    (file) =>
                                      file.type == ChatFileType.USER_KNOWLEDGE
                                  );
                                const userFiles = allUserFiles?.filter((file) =>
                                  attachedFileDescriptors?.some(
                                    (descriptor) =>
                                      descriptor.id === file.file_id
                                  )
                                );

                                return (
                                  <div
                                    className="text-text"
                                    id={`message-${message.messageId}`}
                                    key={messageReactComponentKey}
                                    ref={
                                      i == messageHistory.length - 1
                                        ? lastMessageRef
                                        : null
                                    }
                                  >
                                    {message.is_agentic ? (
                                      <AgenticMessage
                                        resubmit={handleResubmitLastMessage}
                                        error={uncaughtError}
                                        isStreamingQuestions={
                                          message.isStreamingQuestions ?? false
                                        }
                                        isGenerating={
                                          message.is_generating ?? false
                                        }
                                        docSidebarToggled={
                                          documentSidebarVisible &&
                                          (selectedMessageForDocDisplay ==
                                            message.messageId ||
                                            selectedMessageForDocDisplay ==
                                              secondLevelMessage?.messageId)
                                        }
                                        isImprovement={
                                          message.isImprovement ||
                                          nextMessage?.isImprovement
                                        }
                                        secondLevelGenerating={
                                          (message.second_level_generating &&
                                            currentChatState !== "input") ||
                                          false
                                        }
                                        secondLevelSubquestions={message.sub_questions?.filter(
                                          (subQuestion) =>
                                            subQuestion.level === 1
                                        )}
                                        secondLevelAssistantMessage={
                                          (message.second_level_message &&
                                          message.second_level_message.length >
                                            0
                                            ? message.second_level_message
                                            : secondLevelAssistantMessage) ||
                                          undefined
                                        }
                                        subQuestions={
                                          message.sub_questions?.filter(
                                            (subQuestion) =>
                                              subQuestion.level === 0
                                          ) || []
                                        }
                                        agenticDocs={
                                          message.agentic_docs || agenticDocs
                                        }
                                        toggleDocDisplay={(
                                          agentic: boolean
                                        ) => {
                                          if (agentic) {
                                            updateCurrentSelectedMessageForDocDisplay(
                                              message.messageId
                                            );
                                          } else {
                                            updateCurrentSelectedMessageForDocDisplay(
                                              secondLevelMessage
                                                ? secondLevelMessage.messageId
                                                : null
                                            );
                                          }
                                        }}
                                        docs={
                                          message?.documents &&
                                          message?.documents.length > 0
                                            ? message?.documents
                                            : parentMessage?.documents
                                        }
                                        setPresentingDocument={
                                          setPresentingDocument
                                        }
                                        continueGenerating={
                                          (i == messageHistory.length - 1 &&
                                            canContinue) ||
                                          false
                                            ? continueGenerating
                                            : undefined
                                        }
                                        overriddenModel={
                                          message.overridden_model
                                        }
                                        regenerate={createRegenerator({
                                          messageId: message.messageId,
                                          parentMessage: parentMessage!,
                                        })}
                                        otherMessagesCanSwitchTo={
                                          parentMessage?.childrenMessageIds ||
                                          []
                                        }
                                        onMessageSelection={onMessageSelection}
                                        isActive={
                                          messageHistory.length - 1 == i ||
                                          messageHistory.length - 2 == i
                                        }
                                        selectedDocuments={selectedDocuments}
                                        toggleDocumentSelection={(
                                          second: boolean
                                        ) => {
                                          if (
                                            (!second &&
                                              !documentSidebarVisible) ||
                                            (documentSidebarVisible &&
                                              selectedMessageForDocDisplay ===
                                                message.messageId)
                                          ) {
                                            toggleDocumentSidebar();
                                          }
                                          if (
                                            (second &&
                                              !documentSidebarVisible) ||
                                            (documentSidebarVisible &&
                                              selectedMessageForDocDisplay ===
                                                secondLevelMessage?.messageId)
                                          ) {
                                            toggleDocumentSidebar();
                                          }

                                          updateCurrentSelectedMessageForDocDisplay(
                                            second
                                              ? secondLevelMessage?.messageId ||
                                                  null
                                              : message.messageId
                                          );
                                        }}
                                        currentPersona={liveAssistant}
                                        alternativeAssistant={
                                          currentAlternativeAssistant
                                        }
                                        messageId={message.messageId}
                                        content={message.message}
                                        files={message.files}
                                        query={
                                          messageHistory[i]?.query || undefined
                                        }
                                        citedDocuments={getCitedDocumentsFromMessage(
                                          message
                                        )}
                                        toolCall={message.toolCall}
                                        isComplete={
                                          i !== messageHistory.length - 1 ||
                                          (currentChatState != "streaming" &&
                                            currentChatState != "toolBuilding")
                                        }
                                        handleFeedback={
                                          i === messageHistory.length - 1 &&
                                          currentChatState != "input"
                                            ? undefined
                                            : (feedbackType: FeedbackType) =>
                                                setCurrentFeedback([
                                                  feedbackType,
                                                  message.messageId as number,
                                                ])
                                        }
                                      />
                                    ) : (
                                      <AIMessage
                                        userKnowledgeFiles={userFiles}
                                        docs={
                                          message?.documents &&
                                          message?.documents.length > 0
                                            ? message?.documents
                                            : parentMessage?.documents
                                        }
                                        setPresentingDocument={
                                          setPresentingDocument
                                        }
                                        index={i}
                                        continueGenerating={
                                          (i == messageHistory.length - 1 &&
                                            canContinue) ||
                                          false
                                            ? continueGenerating
                                            : undefined
                                        }
                                        overriddenModel={
                                          message.overridden_model
                                        }
                                        regenerate={createRegenerator({
                                          messageId: message.messageId,
                                          parentMessage: parentMessage!,
                                        })}
                                        otherMessagesCanSwitchTo={
                                          parentMessage?.childrenMessageIds ||
                                          []
                                        }
                                        onMessageSelection={onMessageSelection}
                                        isActive={
                                          messageHistory.length - 1 == i
                                        }
                                        selectedDocuments={selectedDocuments}
                                        toggleDocumentSelection={() => {
                                          if (
                                            !documentSidebarVisible ||
                                            (documentSidebarVisible &&
                                              selectedMessageForDocDisplay ===
                                                message.messageId)
                                          ) {
                                            toggleDocumentSidebar();
                                          }

                                          updateCurrentSelectedMessageForDocDisplay(
                                            message.messageId
                                          );
                                        }}
                                        currentPersona={liveAssistant}
                                        alternativeAssistant={
                                          currentAlternativeAssistant
                                        }
                                        messageId={message.messageId}
                                        content={message.message}
                                        files={message.files}
                                        query={
                                          messageHistory[i]?.query || undefined
                                        }
                                        citedDocuments={getCitedDocumentsFromMessage(
                                          message
                                        )}
                                        toolCall={message.toolCall}
                                        isComplete={
                                          i !== messageHistory.length - 1 ||
                                          (currentChatState != "streaming" &&
                                            currentChatState != "toolBuilding")
                                        }
                                        hasDocs={
                                          (message.documents &&
                                            message.documents.length > 0) ===
                                          true
                                        }
                                        handleFeedback={
                                          i === messageHistory.length - 1 &&
                                          currentChatState != "input"
                                            ? undefined
                                            : (feedbackType) =>
                                                setCurrentFeedback([
                                                  feedbackType,
                                                  message.messageId as number,
                                                ])
                                        }
                                        handleSearchQueryEdit={
                                          i === messageHistory.length - 1 &&
                                          currentChatState == "input"
                                            ? (newQuery) => {
                                                if (!previousMessage) {
                                                  setPopup({
                                                    type: "error",
                                                    message:
                                                      "Cannot edit query of first message - please refresh the page and try again.",
                                                  });
                                                  return;
                                                }
                                                if (
                                                  previousMessage.messageId ===
                                                  null
                                                ) {
                                                  setPopup({
                                                    type: "error",
                                                    message:
                                                      "Cannot edit query of a pending message - please wait a few seconds and try again.",
                                                  });
                                                  return;
                                                }
                                                onSubmit({
                                                  message: "", // dummy value, overridden by messageIdToResend
                                                  selectedFiles: [],
                                                  selectedFolders: [],
                                                  currentMessageFiles: [],
                                                  useAgentSearch: false,

                                                  messageIdToResend:
                                                    previousMessage.messageId,
                                                  queryOverride: newQuery,
                                                  alternativeAssistantOverride:
                                                    currentAlternativeAssistant,
                                                });
                                              }
                                            : undefined
                                        }
                                        handleForceSearch={() => {
                                          if (
                                            previousMessage &&
                                            previousMessage.messageId
                                          ) {
                                            createRegenerator({
                                              messageId: message.messageId,
                                              parentMessage: parentMessage!,
                                              forceSearch: true,
                                            })(llmManager.currentLlm);
                                          } else {
                                            setPopup({
                                              type: "error",
                                              message:
                                                "Failed to force search - please refresh the page and try again.",
                                            });
                                          }
                                        }}
                                        retrievalDisabled={
                                          currentAlternativeAssistant
                                            ? !personaIncludesRetrieval(
                                                currentAlternativeAssistant!
                                              )
                                            : !retrievalEnabled
                                        }
                                      />
                                    )}
                                  </div>
                                );
                              } else {
                                return (
                                  <div key={messageReactComponentKey}>
                                    <AIMessage
                                      setPresentingDocument={
                                        setPresentingDocument
                                      }
                                      key={-2}
                                      currentPersona={liveAssistant}
                                      messageId={message.messageId}
                                      content={
                                        <ErrorBanner
                                          resubmit={handleResubmitLastMessage}
                                          error={message.message}
                                          showStackTrace={
                                            message.stackTrace
                                              ? () =>
                                                  setStackTraceModalContent(
                                                    message.stackTrace!
                                                  )
                                              : undefined
                                          }
                                        />
                                      }
                                    />
                                  </div>
                                );
                              }
                            })}

                            {(currentChatState == "loading" ||
                              (loadingError &&
                                !currentRegenerationState?.regenerating &&
                                messageHistory[messageHistory.length - 1]
                                  ?.type != "user")) && (
                              <HumanMessage
                                setPresentingDocument={setPresentingDocument}
                                key={-2}
                                messageId={-1}
                                content={submittedMessage}
                              />
                            )}

                            {currentChatState == "loading" && (
                              <div
                                key={`${messageHistory.length}-${chatSessionId}`}
                              >
                                <AIMessage
                                  setPresentingDocument={setPresentingDocument}
                                  key={-3}
                                  currentPersona={liveAssistant}
                                  alternativeAssistant={null}
                                  messageId={null}
                                  content={
                                    <div
                                      key={"Generating"}
                                      className="mr-auto relative inline-block"
                                    >
                                      <span className="text-sm loading-text">
                                        Thinking...
                                      </span>
                                    </div>
                                  }
                                />
                              </div>
                            )}

                            {loadingError && (
                              <div key={-1}>
                                <AIMessage
                                  setPresentingDocument={setPresentingDocument}
                                  currentPersona={liveAssistant}
                                  messageId={-1}
                                  content={
                                    <p className="text-red-700 text-sm my-auto">
                                      {loadingError}
                                    </p>
                                  }
                                />
                              </div>
                            )}
                            {messageHistory.length > 0 && (
                              <div
                                style={{
                                  height: !autoScrollEnabled
                                    ? getContainerHeight()
                                    : undefined,
                                }}
                              />
                            )}

                            {/* Some padding at the bottom so the search bar has space at the bottom to not cover the last message*/}
                            <div ref={endPaddingRef} className="h-[95px]" />

                            <div ref={endDivRef} />
                          </div>
                        </div>
                        <div
                          ref={inputRef}
                          className="absolute pointer-events-none bottom-0 z-10 w-full"
                        >
                          {aboveHorizon && (
                            <div className="mx-auto w-fit !pointer-events-none flex sticky justify-center">
                              <button
                                onClick={() => clientScrollToBottom()}
                                className="p-1 pointer-events-auto text-neutral-700 dark:text-neutral-800 rounded-2xl bg-neutral-200 border border-border  mx-auto "
                              >
                                <FiArrowDown size={18} />
                              </button>
                            </div>
                          )}

                          <div className="pointer-events-auto w-[95%] mx-auto relative mb-8">
                            <ChatInputBar
                              proSearchEnabled={proSearchEnabled}
                              setProSearchEnabled={() => toggleProSearch()}
                              toggleDocumentSidebar={toggleDocumentSidebar}
                              availableSources={sources}
                              availableDocumentSets={documentSets}
                              availableTags={tags}
                              filterManager={filterManager}
                              llmManager={llmManager}
                              removeDocs={() => {
                                clearSelectedDocuments();
                              }}
                              retrievalEnabled={retrievalEnabled}
                              toggleDocSelection={() =>
                                setToggleDocSelection(true)
                              }
                              showConfigureAPIKey={() =>
                                setShowApiKeyModal(true)
                              }
                              selectedDocuments={selectedDocuments}
                              message={message}
                              setMessage={setMessage}
                              stopGenerating={stopGenerating}
                              onSubmit={() => {
                                onSubmit({
                                  message: message,
                                  selectedFiles: selectedFiles,
                                  selectedFolders: selectedFolders,
                                  currentMessageFiles: currentMessageFiles,
                                  useAgentSearch: proSearchEnabled,
                                });
                              }}
                              chatState={currentChatState}
                              alternativeAssistant={alternativeAssistant}
                              selectedAssistant={
                                selectedAssistant || liveAssistant
                              }
                              setAlternativeAssistant={setAlternativeAssistant}
                              setFiles={setCurrentMessageFiles}
                              handleFileUpload={handleMessageSpecificFileUpload}
                              textAreaRef={textAreaRef}
                            />
                            {enterpriseSettings &&
                              enterpriseSettings.custom_lower_disclaimer_content && (
                                <div className="mobile:hidden mt-4 flex items-center justify-center relative w-[95%] mx-auto">
                                  <div className="text-sm text-text-500 max-w-searchbar-max px-4 text-center">
                                    <MinimalMarkdown
                                      content={
                                        enterpriseSettings.custom_lower_disclaimer_content
                                      }
                                    />
                                  </div>
                                </div>
                              )}
                            {enterpriseSettings &&
                              enterpriseSettings.use_custom_logotype && (
                                <div className="hidden lg:block absolute right-0 bottom-0">
                                  <img
                                    src="/api/enterprise-settings/logotype"
                                    alt="logotype"
                                    style={{ objectFit: "contain" }}
                                    className="w-fit h-8"
                                  />
                                </div>
                              )}
                          </div>
                        </div>
                      </div>

                      <div
                        style={{ transition: "width 0.30s ease-out" }}
                        className={`
                          flex-none 
                          overflow-y-hidden 
                          transition-all 
                          bg-opacity-80
                          duration-300 
                          ease-in-out
                          h-full
                          ${
                            documentSidebarVisible && !settings?.isMobile
                              ? "w-[350px]"
                              : "w-[0px]"
                          }
                      `}
                      />
                    </div>
                  )}
                </Dropzone>
              ) : (
                <div className="mx-auto h-full flex">
                  <div
                    style={{ transition: "width 0.30s ease-out" }}
                    className={`flex-none bg-transparent transition-all bg-opacity-80 duration-300 ease-in-out h-full
                        ${
                          sidebarVisible && !settings?.isMobile
                            ? "w-[250px] "
                            : "w-[0px]"
                        }`}
                  />
                  <div className="my-auto">
                    <OnyxInitializingLoader />
                  </div>
                </div>
              )}
            </div>
          </div>
          <FixedLogo backgroundToggled={sidebarVisible || showHistorySidebar} />
        </div>
      </div>
    </>
  );
}
