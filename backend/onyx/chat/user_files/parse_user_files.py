from uuid import UUID

from sqlalchemy.orm import Session

from onyx.db.models import Persona
from onyx.db.models import UserFile
from onyx.db.projects import get_user_files_from_project
from onyx.file_store.models import InMemoryChatFile
from onyx.file_store.utils import get_user_files_as_user
from onyx.file_store.utils import load_in_memory_chat_files
from onyx.tools.models import SearchToolOverrideKwargs
from onyx.utils.logger import setup_logger


logger = setup_logger()


def parse_user_files(
    user_file_ids: list[UUID],
    db_session: Session,
    persona: Persona,
    actual_user_input: str,
    project_id: int,
    # should only be None if auth is disabled
    user_id: UUID | None,
) -> tuple[list[InMemoryChatFile], list[UserFile], SearchToolOverrideKwargs | None]:
    """
    Parse user files and folders into in-memory chat files and create search tool override kwargs.
    Only creates SearchToolOverrideKwargs if token overflow occurs or folders are present.

    Args:
        user_file_ids: List of user file IDs to load
        db_session: Database session
        persona: Persona to calculate available tokens
        actual_user_input: User's input message for token calculation
        project_id: Project ID to validate file ownership
        user_id: User ID to validate file ownership

    Returns:
        Tuple of (
            loaded user files,
            user file models,
            search tool override kwargs if token
                overflow or folders present
        )
    """
    # Return empty results if no files or folders specified
    if not user_file_ids and not project_id:
        return [], [], None

    project_user_file_ids = []

    if project_id and user_id:
        project_user_file_ids.extend(
            [
                file.id
                for file in get_user_files_from_project(project_id, user_id, db_session)
            ]
        )

    # Load user files from the database into memory
    user_files = load_in_memory_chat_files(
        user_file_ids + project_user_file_ids or [],
        db_session,
    )

    user_file_models = get_user_files_as_user(
        user_file_ids + project_user_file_ids or [],
        user_id,
        db_session,
    )

    # Calculate token count for the files, need to import here to avoid circular import
    # TODO: fix this
    from onyx.db.user_documents import calculate_user_files_token_count
    from onyx.chat.prompt_builder.citations_prompt import (
        compute_max_document_tokens_for_persona,
    )

    total_tokens = calculate_user_files_token_count(
        user_file_ids + project_user_file_ids or [],
        db_session,
    )

    # Calculate available tokens for documents based on prompt, user input, etc.
    available_tokens = compute_max_document_tokens_for_persona(
        db_session=db_session,
        persona=persona,
        actual_user_input=actual_user_input,
    )

    logger.debug(
        f"Total file tokens: {total_tokens}, Available tokens: {available_tokens}"
    )

    have_enough_tokens = total_tokens <= available_tokens

    # If we have enough tokens and no folders, we don't need search
    # we can just pass them into the prompt directly
    if have_enough_tokens and False:
        # No search tool override needed - files can be passed directly
        return user_files, user_file_models, None

    # Token overflow or folders present - need to use search tool
    override_kwargs = SearchToolOverrideKwargs(
        force_no_rerank=have_enough_tokens,
        alternate_db_session=None,
        retrieved_sections_callback=None,
        skip_query_analysis=have_enough_tokens,
        user_file_ids=user_file_ids + project_user_file_ids or [],
    )

    return user_files, user_file_models, override_kwargs
