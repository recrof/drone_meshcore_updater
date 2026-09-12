#pragma once
#include <stddef.h>
#include <stdint.h>
enum http_final_call { HTTP_DATA_MORE, HTTP_DATA_FINAL };
enum http_method { HTTP_GET };
struct http_response { uint8_t *body_frag_start; size_t body_frag_len; uint16_t http_status_code; };
struct http_request {
  enum http_method method;
  const char *url, *host, *protocol;
  int (*response)(struct http_response *, enum http_final_call, void *);
  uint8_t *recv_buf; size_t recv_buf_len;
};
int http_client_req(int fd, struct http_request *req, int32_t timeout, void *user);
