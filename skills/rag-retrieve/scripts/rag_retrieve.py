#!/usr/bin/env python3
"""
RAG检索脚本
调用本地RAG API进行文档检索
"""

import argparse
import hashlib
import json
import os
import sys

try:
    import requests
except ImportError:
    print("Error: requests module is required. Please install it with: pip install requests")
    sys.exit(1)


# 默认配置
DEFAULT_BACKEND_HOST = os.getenv("BACKEND_HOST", "https://wit-springfield-remarks-miscellaneous.trycloudflare.com")
DEFAULT_MASTERKEY = os.getenv("MASTERKEY", "master")


def load_config() -> dict:
    """
    从项目根目录的robot_config.json加载配置

    Returns:
        dict: 配置字典
    """
    print(os.path.dirname(__file__))
    config_path = os.path.join(os.path.dirname(__file__), '..', '..', '..', 'robot_config.json')

    if os.path.exists(config_path):
        try:
            with open(config_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            print(f"Warning: Failed to load config file: {e}", file=sys.stderr)

    return {}


def rag_retrieve(query: str, top_k: int = 100, config: dict = None) -> str:
    """
    调用RAG检索API

    Args:
        bot_id: Bot标识符（如果为None则从config读取）
        query: 检索查询内容
        top_k: 返回结果数量
        config: 配置字典（可选）

    Returns:
        str: markdown格式的检索结果
    """
    if config is None:
        config = {}

    # 从config.env读取配置，如果没有则使用默认值
    host =DEFAULT_BACKEND_HOST
    masterkey = DEFAULT_MASTERKEY

    bot_id = config.get('bot_id')

    if not bot_id:
        return "Error: bot_id is required"

    if not query:
        return "Error: query is required"

    url = f"{host}/v1/rag_retrieve/{bot_id}"

    # 生成认证token
    token_input = f"{masterkey}:{bot_id}"
    auth_token = hashlib.md5(token_input.encode()).hexdigest()

    headers = {
        "content-type": "application/json",
        "authorization": f"Bearer {auth_token}"
    }
    data = {
        "query": query,
        "top_k": top_k
    }

    try:
        response = requests.post(url, json=data, headers=headers, timeout=30)

        if response.status_code != 200:
            return f"Error: RAG API returned status code {response.status_code}. Response: {response.text}"

        try:
            response_data = response.json()
        except json.JSONDecodeError as e:
            return f"Error: Failed to parse API response as JSON. Error: {str(e)}, Raw response: {response.text}"

        # 提取markdown字段
        if "markdown" in response_data:
            return response_data["markdown"]
        else:
            return f"Error: 'markdown' field not found in API response. Response: {json.dumps(response_data, indent=2, ensure_ascii=False)}"

    except requests.exceptions.RequestException as e:
        return f"Error: Failed to connect to RAG API. {str(e)}"
    except Exception as e:
        return f"Error: {str(e)}"


def main():
    parser = argparse.ArgumentParser(
        description="RAG检索工具 - 从知识库中检索相关文档"
    )
    parser.add_argument(
        "--query",
        "-q",
        required=True,
        help="检索查询内容"
    )
    parser.add_argument(
        "--top-k",
        "-k",
        type=int,
        default=100,
        help="返回结果数量（默认：100）"
    )

    args = parser.parse_args()

    # 加载配置
    config = load_config()

    result = rag_retrieve(
        query=args.query,
        top_k=args.top_k,
        config=config
    )

    print(result)


if __name__ == "__main__":
    main()
