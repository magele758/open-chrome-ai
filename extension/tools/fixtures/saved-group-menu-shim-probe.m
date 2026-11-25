#import <Foundation/Foundation.h>
#include <stdio.h>

static NSString *const kOldCreatePattern = @"^(Create new tab group|创建新标签页分组)$";
static NSString *const kMarkerPattern = @"^PageLens-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$";

static BOOL patternMatches(NSString *pattern, NSString *text) {
  if (!text) return NO;
  NSRegularExpression *expression = [NSRegularExpression regularExpressionWithPattern:pattern options:NSRegularExpressionCaseInsensitive error:nil];
  if (!expression) return NO;
  return [expression firstMatchInString:text options:0 range:NSMakeRange(0, text.length)] != nil;
}

static void report(const char *key, BOOL matched) {
  printf("%s %s\n", key, matched ? "MATCH" : "MISS");
}

int main(void) {
  @autoreleasepool {
    NSString *marker = @"PageLens-1df2bdb2-55d6-4b8c-94e5-47852548a68e";
    report("zh_exact", patternMatches(kOldCreatePattern, @"创建新标签页分组"));
    report("zh_shortcut", patternMatches(kOldCreatePattern, @"创建新标签页分组 ⌃⌘P"));
    report("en_shortcut", patternMatches(kOldCreatePattern, @"Create new tab group ⌃⌘P"));
    report("label", patternMatches(kOldCreatePattern, @"“PageLens · MX 421742”分组 - 已关闭"));
    report("partial", patternMatches(kOldCreatePattern, @"新标签页分组"));
    report("empty", patternMatches(kOldCreatePattern, @""));
    report("nil_text", patternMatches(kOldCreatePattern, nil));
    report("marker", patternMatches(kMarkerPattern, marker));
    report("marker_extra", patternMatches(kMarkerPattern, [marker stringByAppendingString:@" ⌃⌘P"]));
    fflush(stdout);
  }
  return 0;
}
