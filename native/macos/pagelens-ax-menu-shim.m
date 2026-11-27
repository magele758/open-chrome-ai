#import <Foundation/Foundation.h>
#import <objc/runtime.h>

// The previously granted helper matches the create-row label exactly, so the
// shortcut suffix on Chrome's menu item never qualifies. Widen only that
// pattern. Every other NSRegularExpression in the helper must keep its text.
static IMP originalImp = NULL;

static NSRegularExpression *shim_regularExpressionWithPattern(id self, SEL _cmd, NSString *pattern, NSRegularExpressionOptions options, NSError **error) {
  static NSString *const oldPattern = @"^(Create new tab group|创建新标签页分组)$";
  static NSString *const newPattern = @"^(?:Create new tab group|创建新标签页分组)(?:\\s+[⌃⌥⇧⌘]+.{1,4})?$";
  if (pattern && [pattern isEqualToString:oldPattern]) pattern = newPattern;
  return ((NSRegularExpression *(*)(id, SEL, NSString *, NSRegularExpressionOptions, NSError **))originalImp)(self, _cmd, pattern, options, error);
}

@interface PageLensAxMenuShim : NSObject
@end

@implementation PageLensAxMenuShim

+ (void)load {
  Method method = class_getClassMethod([NSRegularExpression class], @selector(regularExpressionWithPattern:options:error:));
  if (!method) return;
  originalImp = method_setImplementation(method, (IMP)shim_regularExpressionWithPattern);
}

@end
