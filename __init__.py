from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS, PromptServer
from .llm_wildcards import LLMWildcard, LLMPromptVariations, register_routes

NODE_CLASS_MAPPINGS.update(LLMWildcard=LLMWildcard, LLMPromptVariations=LLMPromptVariations)
NODE_DISPLAY_NAME_MAPPINGS.update(LLMWildcard="LLM Wildcard Prompt (legacy)", LLMPromptVariations="LLM Wildcards & Prompt Variations")

if PromptServer is not None and getattr(PromptServer, "instance", None) is not None:
    register_routes(PromptServer.instance.routes)

WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
