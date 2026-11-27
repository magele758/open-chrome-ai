#define main PageLensHelperMain
#import "../../../native/macos/pagelens-ax-helper.m"
#undef main
#include <assert.h>

int main(void) {
  @autoreleasepool {
    assert(groupOpenCommandIndex(@"Open group", YES, @"Open group in new window", YES, YES) == 0);
    assert(groupOpenCommandIndex(@"打开分组", NO, @"在新窗口中打开群组", YES, YES) == 1);
    assert(groupOpenCommandIndex(@"打开分组", NO, @"在新窗口中打开群组", YES, NO) == NSNotFound);
    assert(groupOpenCommandIndex(@"Open group in new window", YES, nil, NO, YES) == 0);
    assert(groupOpenCommandIndex(@"Open group in new window", YES, nil, NO, NO) == NSNotFound);
    assert(groupOpenCommandIndex(@"Open group", NO, @"Move group to new window", YES, YES) == NSNotFound);
    assert(groupOpenCommandIndex(@"打开分组", NO, @"将分组移至新窗口", YES, YES) == NSNotFound);
    assert(groupOpenCommandIndex(@"Open group", NO, @"Open group in new window", NO, YES) == NSNotFound);
    assert(groupOpenCommandIndex(@"Delete group", YES, @"Open group in new window", YES, YES) == NSNotFound);
    assert(isCreateNewTabGroupText(@"创建新标签页分组"));
    assert(isCreateNewTabGroupText(@"Create new tab group"));
    assert(isCreateNewTabGroupText(@"创建新标签页分组 ⌃⌘P"));
    assert(isCreateNewTabGroupText(@"Create new tab group ⌃⌘P"));
    assert(!isCreateNewTabGroupText(@"“PageLens · MX 421742”分组 - 已关闭"));
    assert(!isCreateNewTabGroupText(@"新标签页分组"));
    assert(!isCreateNewTabGroupText(@""));
    assert(!isCreateNewTabGroupText(nil));
  }
  return 0;
}
