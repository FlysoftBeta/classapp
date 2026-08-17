## 思考 Post 以及它的物化版本，以思考：Post 修改后，它的 reply post 怎么处理？bump revision 还是怎么样？

```json
{
  "incident_id": "I_bWjXfMnxgcS2agvZw46Img",
  "environment": "client",
  "build_id": "2e3814a",
  "occurred_at": "2026-08-12T01:54:57.413Z",
  "error": {
    "name": "Error",
    "message": "Post revision collision: f18983f0-be43-404a-b5f7-08ce82b9af8c",
    "stack": "Error: Post revision collision: f18983f0-be43-404a-b5f7-08ce82b9af8c\n    at blob:http://www.opensubtitles.org/89330079-bb82-4c7b-8aea-21bec9997cc6:216:86569\n    at async CF (blob:http://www.opensubtitles.org/89330079-bb82-4c7b-8aea-21bec9997cc6:216:59427)\n    at async Object.savePosts (blob:http://www.opensubtitles.org/89330079-bb82-4c7b-8aea-21bec9997cc6:216:85834)\n    at async Object.reconcilePostPage (blob:http://www.opensubtitles.org/89330079-bb82-4c7b-8aea-21bec9997cc6:216:87947)\n    at async JU (blob:http://www.opensubtitles.org/89330079-bb82-4c7b-8aea-21bec9997cc6:267:426041)\n    at async blob:http://www.opensubtitles.org/89330079-bb82-4c7b-8aea-21bec9997cc6:267:433320\n    at async Promise.all (index 2)\n    at async Object.bootstrap (blob:http://www.opensubtitles.org/89330079-bb82-4c7b-8aea-21bec9997cc6:267:434382)\n    at async jU.resolveEffect (blob:http://www.opensubtitles.org/89330079-bb82-4c7b-8aea-21bec9997cc6:267:416314)\n    at async jU.runEffect (blob:http://www.opensubtitles.org/89330079-bb82-4c7b-8aea-21bec9997cc6:267:413084)"
  },
  "context": {
    "operation": "post.page-cache",
    "operation_id": "07ebb054fc7d3ddf44f2e984",
    "user_id": "f7648133-f4a9-4b9b-b392-31e546dae4fb",
    "client_id": "C-3BC054DF"
  },
  "related_incident_ids": [],
  "group": {
    "id": 25,
    "fingerprint": "ffeadb7ed69a9b64ffe441bcc90e16ed36f5c990323b68f661582f5590ac07b9",
    "top_frame": "at blob:/89330079-bb82-4c7b-8aea-21bec9997cc6:216:86569",
    "occurrence_count": 13,
    "stored_detail_count": 10,
    "first_at": "2026-08-12T01:54:57.413Z",
    "last_at": "2026-08-12T02:01:39.778Z"
  }
}
```

## AI 计费

## 上传图片

## 新的交互模型：

音乐、文章是资源，没有所有者。只不过上传者是第一个看到它的人。
如果在群聊中存在合法消息，那么就是一个合法入口。合法入口可以派生为拥有查看权。
上传文章/搜索音乐 -> 创建资源并获得使用权 -> 通过 Post 派生合法入口 (删除时，不会一起删这个，因为全表搜索太慢了) -> 用户点击，获得使用权限，且加入任意一个资源入口（最近在看、收藏夹）
其中，资源本身受资源权限 ref count，使用权限由资源入口 ref count。
资源聚合类似（书单、歌单），但是它有所有权，因此最好不要使用上述模型。

## potServer

- 应该移入 lib/media
- 它只应阻塞 media 而不是整个系统，生命周期绑定 MediaRuntime
- 不知道为何 windows 上 timeout

## poppler

需要编写新 SDK。
https://chatgpt.com/c/6a79797c-1ea8-83ea-8ee6-ab2150348934

## Gitee 更新

未测试下载情况，deploy-gitee.mjs 不能用

## 思考计费模式

可能全部功能用一个计费系统更好？
公开成本，审计

## 异想天开：

- 远控 (VNC/?)
- 基于邮件的配置下发
- 云游戏
