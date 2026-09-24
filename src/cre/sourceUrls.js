export function safeSourceUrl(value) {
  try {
    const url = new URL(String(value));
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return '';
    for (const key of [...url.searchParams.keys()]) {
      if (
        /key|token|secret|password|authorization|signature|credential/i.test(
          key,
        )
      )
        url.searchParams.delete(key);
    }
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}
