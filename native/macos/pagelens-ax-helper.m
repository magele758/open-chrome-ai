// PageLens Helper — native macOS Accessibility (AXUIElement + CGEvent) helper for Chrome Saved Tab Groups.
// Launched as an app via LaunchServices so macOS TCC attributes Accessibility cleanly
// to `PageLens Helper.app` (`com.pagelens.helper`) rather than Chrome's disclaimed native host child.

#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <ApplicationServices/ApplicationServices.h>

static NSString *phaseFile;
static void phase(NSString *name) {
  if (phaseFile) [name writeToFile:phaseFile atomically:YES encoding:NSUTF8StringEncoding error:nil];
}

static void sleepMs(int ms) {
  usleep((useconds_t)ms * 1000);
}

static id axAttr(AXUIElementRef el, CFStringRef attr) {
  if (!el) return nil;
  CFTypeRef val = NULL;
  if (AXUIElementCopyAttributeValue(el, attr, &val) != kAXErrorSuccess || !val) return nil;
  return CFBridgingRelease(val);
}

static NSString *axStringAttr(AXUIElementRef el, CFStringRef attr) {
  id val = axAttr(el, attr);
  if ([val isKindOfClass:[NSString class]]) return (NSString *)val;
  return nil;
}

static NSString *axRole(AXUIElementRef el) {
  return axStringAttr(el, kAXRoleAttribute) ?: @"";
}

static NSString *axSubrole(AXUIElementRef el) {
  return axStringAttr(el, kAXSubroleAttribute) ?: @"";
}

static NSArray *axChildren(AXUIElementRef el) {
  id kids = axAttr(el, kAXChildrenAttribute);
  if ([kids isKindOfClass:[NSArray class]] && [(NSArray *)kids count] > 0) return (NSArray *)kids;
  id vis = axAttr(el, kAXVisibleChildrenAttribute);
  if ([vis isKindOfClass:[NSArray class]]) return (NSArray *)vis;
  return @[];
}

static NSArray<NSString *> *axTexts(AXUIElementRef el) {
  if (!el) return @[];
  NSArray *keys = @[(__bridge NSString *)kAXTitleAttribute, (__bridge NSString *)kAXDescriptionAttribute,
                    (__bridge NSString *)kAXHelpAttribute, (__bridge NSString *)kAXValueAttribute, @"AXIdentifier"];
  CFArrayRef values = NULL;
  if (AXUIElementCopyMultipleAttributeValues(el, (__bridge CFArrayRef)keys, 0, &values) != kAXErrorSuccess || !values) return @[];
  NSMutableArray *texts = [NSMutableArray array];
  for (id value in CFBridgingRelease(values)) {
    if ([value isKindOfClass:NSString.class] && [value length] && ![texts containsObject:value]) [texts addObject:value];
  }
  return texts;
}

static BOOL regexMatch(NSString *pattern, NSString *text) {
  if (!text.length) return NO;
  NSRegularExpression *re = [NSRegularExpression regularExpressionWithPattern:pattern
                                                                      options:NSRegularExpressionCaseInsensitive
                                                                        error:nil];
  if (!re) return NO;
  return [re firstMatchInString:text options:0 range:NSMakeRange(0, text.length)] != nil;
}

static BOOL anyTextMatches(NSArray<NSString *> *texts, NSString *pattern) {
  for (NSString *raw in texts) {
    NSString *trimmed = [raw stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    if (regexMatch(pattern, trimmed)) return YES;
  }
  return NO;
}

static NSString *const kReTabGroupsBtnExact =
  @"^(tab groups|everything|hidden saved tab groups|menu containing hidden saved tab groups|view and manage your tab groups|saved tab groups|标签页分组|标签页组|标签组|所有标签组|所有标签页分组|隐藏的已存标签页分组|包含隐藏的已存标签页分组的菜单|查看和管理您的标签页组|已保存的标签页分组)$";

static NSString *const kReTabGroupsBtnContains =
  @"(hidden saved tab groups|menu containing hidden saved tab groups|view and manage your tab groups|隐藏的已存标签页分组|包含隐藏的已存标签页分组的菜单|查看和管理您的标签页组|管理标签页分组)";

static NSString *const kReTabGroupsMenuItem =
  @"^(tab groups|saved tab groups|标签页分组|标签页组|标签组|已保存的标签页分组)$";

static NSString *const kReAppMenuBtn =
  @"customize and control (google chrome|chromium)|自定义(及|和)控制\\s*(google chrome|chromium)|有可用的更新.*google chrome";

static NSString *const kReOpenItem =
  @"^(open group|open tab group|open|打开分组|打开标签页组|打开标签页分组|打开标签组|打开组|打开)$";

static NSString *const kReOpenInNewWindow =
  @"^(open group in new window|在新窗口中打开群组|在新窗口中打开分组|在新窗口中打开标签页分组)$";

static BOOL isButtonRole(NSString *role) {
  return [role isEqualToString:@"AXButton"] ||
         [role isEqualToString:@"AXMenuButton"] ||
         [role isEqualToString:@"AXPopUpButton"];
}

static BOOL isTabGroupsButton(AXUIElementRef el, NSString *role) {
  if (!isButtonRole(role)) return NO;
  NSArray<NSString *> *texts = axTexts(el);
  return anyTextMatches(texts, kReTabGroupsBtnExact) || anyTextMatches(texts, kReTabGroupsBtnContains);
}

static BOOL isTabGroupsMenuItem(AXUIElementRef el, NSString *role) {
  if (![role isEqualToString:@"AXMenuItem"] && ![role isEqualToString:@"AXButton"]) return NO;
  return anyTextMatches(axTexts(el), kReTabGroupsMenuItem);
}

static BOOL isAppMenuButton(AXUIElementRef el, NSString *role) {
  if (!isButtonRole(role)) return NO;
  return anyTextMatches(axTexts(el), kReAppMenuBtn);
}

static BOOL beforeDeadline(void);

typedef BOOL (^AXPredicate)(AXUIElementRef el, NSString *role);

static void walkVisit(AXUIElementRef node, AXPredicate pred, int depth, int maxDepth, NSUInteger limit, NSMutableArray *found) {
  if (!node || depth > maxDepth || found.count >= limit || !beforeDeadline()) return;
  NSString *role = axRole(node);
  if ([role isEqualToString:@"AXWebArea"]) return;
  if (pred(node, role)) {
    [found addObject:(__bridge id)node];
    if (found.count >= limit) return;
  }
  for (id child in axChildren(node)) {
    walkVisit((__bridge AXUIElementRef)child, pred, depth + 1, maxDepth, limit, found);
    if (found.count >= limit) return;
  }
}

static NSArray *walkElements(AXUIElementRef root, AXPredicate pred, int maxDepth, NSUInteger limit) {
  NSMutableArray *found = [NSMutableArray array];
  walkVisit(root, pred, 0, maxDepth, limit, found);
  return found;
}

static BOOL axCenter(AXUIElementRef el, CGPoint *outPt) {
  id posVal = axAttr(el, kAXPositionAttribute);
  id szVal = axAttr(el, kAXSizeAttribute);
  if (!posVal || !szVal) return NO;
  CGPoint pos = CGPointZero;
  CGSize sz = CGSizeZero;
  if (!AXValueGetValue((__bridge AXValueRef)posVal, kAXValueTypeCGPoint, &pos)) return NO;
  if (!AXValueGetValue((__bridge AXValueRef)szVal, kAXValueTypeCGSize, &sz)) return NO;
  if (sz.width <= 0 || sz.height <= 0) return NO;
  outPt->x = pos.x + sz.width / 2.0;
  outPt->y = pos.y + sz.height / 2.0;
  return isfinite(outPt->x) && isfinite(outPt->y);
}

static void postMouseEvent(CGEventType type, CGPoint pt, CGMouseButton btn) {
  CGEventRef ev = CGEventCreateMouseEvent(NULL, type, pt, btn);
  if (ev) {
    CGEventPost(kCGHIDEventTap, ev);
    CFRelease(ev);
  }
}

// The marker tab lives only while the extension is waiting for this request.
// Recheck its window, frontmost process and deadline before every UI action.
static NSRunningApplication *targetApp;
static id targetAppElement;
static id targetWindow;
static NSString *windowMarker;
static double deadlineMs;

static BOOL beforeDeadline(void) {
  return [[NSDate date] timeIntervalSince1970] * 1000 < deadlineMs;
}

static BOOL markerMatches(AXUIElementRef window, NSString *marker) {
  NSString *title = axStringAttr(window, kAXTitleAttribute);
  if ([title isEqualToString:marker]) return YES;
  for (NSString *separator in @[@" - ", @" – ", @" — "]) {
    if ([title hasPrefix:[marker stringByAppendingString:separator]]) return YES;
  }
  return NO;
}

static BOOL targetActive(void) {
  if (!beforeDeadline() || !targetApp.active || !markerMatches((__bridge AXUIElementRef)targetWindow, windowMarker)) return NO;
  AXUIElementRef app = (__bridge AXUIElementRef)targetAppElement;
  id win = axAttr(app, kAXFocusedWindowAttribute);
  if (!win || ![axSubrole((__bridge AXUIElementRef)win) isEqualToString:@"AXStandardWindow"]) {
    win = axAttr(app, kAXMainWindowAttribute);
  }
  return win && [win isEqual:targetWindow];
}

static BOOL press(id node) {
  if (!node || !targetActive()) return NO;
  return AXUIElementPerformAction((__bridge AXUIElementRef)node, kAXPressAction) == kAXErrorSuccess;
}

static BOOL hover(id node) {
  CGPoint pt;
  if (!node || !targetActive() || !axCenter((__bridge AXUIElementRef)node, &pt)) return NO;
  postMouseEvent(kCGEventMouseMoved, pt, kCGMouseButtonLeft);
  return YES;
}

static void escapeMenu(void) {
  if (!targetActive()) return;
  for (NSNumber *down in @[@YES, @NO]) {
    CGEventRef event = CGEventCreateKeyboardEvent(NULL, 53, down.boolValue);
    if (event) { CGEventPostToPid(targetApp.processIdentifier, event); CFRelease(event); }
  }
  sleepMs(100);
}

static NSArray<NSRunningApplication *> *chromeApps(NSString *appName) {
  if ([appName isEqualToString:@"Google Chrome"]) {
    return [NSRunningApplication runningApplicationsWithBundleIdentifier:@"com.google.Chrome"];
  }
  NSMutableArray *apps = [NSMutableArray array];
  for (NSRunningApplication *app in [NSWorkspace sharedWorkspace].runningApplications) {
    if ([app.localizedName isEqualToString:appName]) [apps addObject:app];
  }
  return apps;
}

static BOOL bindWindow(NSString *appName, NSString *marker) {
  phase(@"bind_window");
  if (!regexMatch(@"^PageLens-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$", marker)) return NO;
  for (NSRunningApplication *app in chromeApps(appName)) {
    id obj = CFBridgingRelease(AXUIElementCreateApplication(app.processIdentifier));
    AXUIElementRef ax = (__bridge AXUIElementRef)obj;
    AXUIElementSetMessagingTimeout(ax, 1.0);
    AXUIElementSetAttributeValue(ax, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);
    for (id w in axAttr(ax, kAXWindowsAttribute)) {
      AXUIElementRef win = (__bridge AXUIElementRef)w;
      if (![axSubrole(win) isEqualToString:@"AXStandardWindow"] || !markerMatches(win, marker)) continue;
      if (targetWindow) return NO;
      targetApp = app;
      targetAppElement = obj;
      targetWindow = w;
      windowMarker = marker;
    }
  }
  // The requesting extension already focused this window; a subsequent user
  // focus change cancels the request instead of bringing Chrome back to front.
  return targetWindow && targetActive();
}

static id findStandardWindow(AXUIElementRef appEl, NSUInteger *windowCountOut) {
  id winsObj = axAttr(appEl, kAXWindowsAttribute);
  NSArray *wins = [winsObj isKindOfClass:[NSArray class]] ? (NSArray *)winsObj : @[];
  if (windowCountOut) *windowCountOut = wins.count;
  id focused = axAttr(appEl, kAXFocusedWindowAttribute);
  if (focused && [axSubrole((__bridge AXUIElementRef)focused) isEqualToString:@"AXStandardWindow"]) {
    return focused;
  }
  for (id w in wins) {
    if ([axSubrole((__bridge AXUIElementRef)w) isEqualToString:@"AXStandardWindow"]) {
      return w;
    }
  }
  return wins.firstObject;
}

static NSArray *collectPopupContainers(AXUIElementRef appEl) {
  NSMutableArray *containers = [NSMutableArray array];
  id topKids = axAttr(appEl, kAXChildrenAttribute);
  if ([topKids isKindOfClass:[NSArray class]]) {
    for (id el in (NSArray *)topKids) {
      AXUIElementRef ref = (__bridge AXUIElementRef)el;
      NSString *role = axRole(ref);
      if ([role isEqualToString:@"AXMenu"] || [role isEqualToString:@"AXPopover"] || [role isEqualToString:@"AXSheet"]) {
        [containers addObject:el];
      } else if ([role isEqualToString:@"AXWindow"] && ![axSubrole(ref) isEqualToString:@"AXStandardWindow"]) {
        [containers addObject:el];
      }
    }
  }
  id focused = axAttr(appEl, kAXFocusedUIElementAttribute);
  for (int i = 0; focused && i < 12; i++) {
    AXUIElementRef ref = (__bridge AXUIElementRef)focused;
    if ([axRole(ref) isEqualToString:@"AXMenu"]) [containers addObject:focused];
    focused = axAttr(ref, kAXParentAttribute);
  }
  if (containers.count) return containers;
  NSArray *embedded = walkElements((__bridge AXUIElementRef)targetWindow, ^BOOL(AXUIElementRef el, NSString *role) {
    return [role isEqualToString:@"AXMenu"] || [role isEqualToString:@"AXPopover"];
  }, 14, 16);
  [containers addObjectsFromArray:embedded];
  return containers;
}

static NSArray *findItems(id root, AXPredicate pred) {
  NSMutableOrderedSet *items = [NSMutableOrderedSet orderedSet];
  NSArray *containers = root ? @[root] : collectPopupContainers((__bridge AXUIElementRef)targetAppElement);
  for (id container in containers) {
    [items addObjectsFromArray:walkElements((__bridge AXUIElementRef)container, pred, 12, 2)];
    if (items.count >= 2) break;
  }
  return items.array;
}

static NSArray *waitForItems(id root, AXPredicate predicate) {
  for (int i = 0; i < 7 && targetActive(); i++) {
    NSArray *items = findItems(root, predicate);
    if (items.count) return items;
    sleepMs(90);
  }
  return @[];
}

static NSDictionary *failed(NSString *code, NSString *error) {
  return @{ @"ok": @NO, @"code": code, @"error": error };
}

static NSDictionary *openResult(id item, NSString *route) {
  phase(route);
  if (!press(item)) return failed(@"AX_PRESS_FAILED", @"Chrome 未接受打开标签组操作，或请求窗口已切换。");
  return @{ @"ok": @YES, @"via": route };
}

static id submenu(id menuItem) {
  for (id child in axChildren((__bridge AXUIElementRef)menuItem)) {
    if ([axRole((__bridge AXUIElementRef)child) isEqualToString:@"AXMenu"]) return child;
  }
  return nil;
}

static NSString *itemTitle(id item) {
  return axStringAttr((__bridge AXUIElementRef)item, kAXTitleAttribute) ?: @"";
}

// Chromium puts Open first and Open/Move to new window second, before the
// separator and individual tabs. Never search tab titles for either command.
static NSUInteger groupOpenCommandIndex(NSString *first, BOOL firstEnabled,
                                        NSString *second, BOOL secondEnabled, BOOL allowNewWindow) {
  if (regexMatch(kReOpenItem, first)) {
    if (firstEnabled) return 0;
    if (allowNewWindow && secondEnabled && regexMatch(kReOpenInNewWindow, second)) return 1;
  }
  if (allowNewWindow && firstEnabled && regexMatch(kReOpenInNewWindow, first)) return 0;
  return NSNotFound;
}

static NSString *commandTitle(id node) {
  AXUIElementRef el = (__bridge AXUIElementRef)node;
  NSString *role = axRole(el);
  if (![role isEqualToString:@"AXMenuItem"] && ![role isEqualToString:@"AXButton"]) return nil;
  NSString *title = itemTitle(node);
  return title.length ? title : axStringAttr(el, kAXDescriptionAttribute);
}

static id waitForGroupOpenCommand(id entry, BOOL allowNewWindow) {
  hover(entry);
  for (int i = 0; i < 7 && targetActive(); i++) {
    NSArray *commands = axChildren((__bridge AXUIElementRef)(submenu(entry) ?: entry));
    id first = commands.firstObject;
    id second = commands.count > 1 ? commands[1] : nil;
    NSUInteger index = groupOpenCommandIndex(
      commandTitle(first), [axAttr((__bridge AXUIElementRef)first, kAXEnabledAttribute) boolValue],
      commandTitle(second), [axAttr((__bridge AXUIElementRef)second, kAXEnabledAttribute) boolValue], allowNewWindow);
    if (index != NSNotFound) return commands[index];
    sleepMs(90);
  }
  return nil;
}

static NSArray *tabTitlesInMenu(NSArray *children) {
  // The Cocoa model separates the group's commands and saved tabs with a separator.
  // On systems that omit separator AX nodes, locate the final static command.
  NSRange tabRange = NSMakeRange(0, 0);
  BOOL foundDivider = NO;
  for (NSUInteger i = 0; i < children.count; i++) {
    NSString *title = itemTitle(children[i]);
    if (!title.length || regexMatch(@"^(delete group|delete tab group|leave group|删除分组|删除标签页组|退出分组|退出群组)$", title)) {
      tabRange = NSMakeRange(i + 1, children.count - i - 1);
      foundDivider = YES;
      break;
    }
  }
  if (!foundDivider) return nil;
  NSMutableArray *titles = [NSMutableArray array];
  for (id child in [children subarrayWithRange:tabRange]) {
    NSString *title = itemTitle(child);
    if (title.length) [titles addObject:title];
  }
  return titles;
}

static NSDictionary *openCocoaMenu(NSDictionary *req) {
  phase(@"cocoa_menu");
  id appMenu = axAttr((__bridge AXUIElementRef)targetAppElement, kAXMenuBarAttribute);
  for (id top in axChildren((__bridge AXUIElementRef)appMenu)) {
    if (!anyTextMatches(axTexts((__bridge AXUIElementRef)top), kReTabGroupsMenuItem) || !targetActive()) continue;
    press(top);
    id menu = submenu(top);
    phase(@"cocoa_menu_items");
    NSArray *entries = axChildren((__bridge AXUIElementRef)menu);
    NSMutableArray *peers = [NSMutableArray array];
    for (id entry in entries) {
      if (!beforeDeadline()) break;
      if ([req[@"names"] containsObject:itemTitle(entry)] && submenu(entry)) [peers addObject:entry];
    }
    NSInteger index = [req[@"index"] integerValue];
    NSUInteger expected = [req[@"peerCount"] unsignedIntegerValue];
    if (!expected || peers.count != expected) { escapeMenu(); return nil; }
    phase(@"cocoa_group_match");
    id candidate = nil;
    if (expected == 1) {
      candidate = peers.firstObject;
    } else {
      NSArray *labels = req[@"tabLabels"];
      // Identical names can span dozens of saved groups. Validate the selected
      // submenu against the actual saved tab labels before opening one candidate.
      if (labels.count && index >= 0 && index < (NSInteger)peers.count) {
        id byTime = peers[(NSUInteger)index];
        NSArray *titles = tabTitlesInMenu(axChildren((__bridge AXUIElementRef)submenu(byTime)));
        if ([titles isEqualToArray:labels]) candidate = byTime;
      }
      if (!candidate && labels.count) {
        for (id peer in peers) {
          if (!beforeDeadline()) break;
          NSArray *titles = tabTitlesInMenu(axChildren((__bridge AXUIElementRef)submenu(peer)));
          if (![titles isEqualToArray:labels]) continue;
          if (candidate) { escapeMenu(); return failed(@"AMBIGUOUS_GROUP", @"同名保存组的菜单内容相同，无法确认目标。请在 Chrome 打开目标组后重试。"); }
          candidate = peer;
        }
        if (!beforeDeadline()) candidate = nil;
      }
    }
    if (!candidate) { escapeMenu(); return nil; }
    id command = waitForGroupOpenCommand(candidate, [req[@"allowNewWindow"] boolValue]);
    if (command) {
      NSMutableDictionary *res = [openResult(command, @"menu_bar") mutableCopy];
      if (expected > 1 && [res[@"ok"] boolValue]) res[@"candidateOpened"] = @YES;
      return res;
    }
    escapeMenu();
  }
  return nil;
}

// Chrome appends the menu shortcut, for example "创建新标签页分组 ⌃⌘P".
// The command stays anchored so a group label or "新标签页分组" cannot pass.
static BOOL isCreateNewTabGroupText(NSString *raw) {
  if (![raw isKindOfClass:NSString.class]) return NO;
  NSString *text = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
  return regexMatch(@"^(?:Create new tab group|创建新标签页分组)(?:\\s+[⌃⌥⇧⌘]+.{1,4})?$", text);
}

// Both STGEverythingMenu variants expose one creation command, then a separator,
// then every saved group in descending creation time. Never use an arbitrary
// popup's matching "Delete", "Open" or other command as a group.
static BOOL isSavedGroupsMenu(AXUIElementRef el, NSString *role) {
  if (![role isEqualToString:@"AXMenu"]) return NO;
  id first = axChildren(el).firstObject;
  if (!first) return NO;
  for (NSString *raw in axTexts((__bridge AXUIElementRef)first)) {
    if (isCreateNewTabGroupText(raw)) return YES;
  }
  return NO;
}

static NSDictionary *openFromGroupList(NSDictionary *req, id anchor, BOOL inAppMenu) {
  AXPredicate isList = ^BOOL(AXUIElementRef el, NSString *role) { return isSavedGroupsMenu(el, role); };
  NSArray *menus = anchor ? waitForItems(anchor, isList) : @[];
  if (!menus.count) menus = waitForItems(nil, isList);
  if (menus.count != 1) return nil;
  NSArray *rows = axChildren((__bridge AXUIElementRef)menus.firstObject);
  NSMutableArray *matches = [NSMutableArray array];
  for (NSUInteger i = 0; i < rows.count && beforeDeadline(); i++) {
    AXUIElementRef el = (__bridge AXUIElementRef)rows[i];
    if (![axRole(el) isEqualToString:@"AXMenuItem"]) continue;
    BOOL skip = NO;
    BOOL matched = NO;
    for (NSString *raw in axTexts(el)) {
      NSString *text = [raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if (!text.length) continue;
      if (isCreateNewTabGroupText(text)) { skip = YES; break; }
      if ([req[@"labels"] containsObject:text]) matched = YES;
    }
    if (!skip && matched) [matches addObject:rows[i]];
  }
  if (!beforeDeadline() || !matches.count || matches.count != [req[@"peerCount"] unsignedIntegerValue]) return nil;
  NSInteger index = matches.count == 1 ? 0 : [req[@"index"] integerValue];
  if (index < 0 || index >= (NSInteger)matches.count) return nil;
  id selected = matches[(NSUInteger)index];
  NSString *route = inAppMenu ? @"app_menu" : @"everything_menu";
  if (inAppMenu) {
    selected = waitForGroupOpenCommand(selected, [req[@"allowNewWindow"] boolValue]);
    if (!selected) return nil;
  }
  NSMutableDictionary *res = [openResult(selected, route) mutableCopy];
  if (matches.count > 1 && [res[@"ok"] boolValue]) res[@"candidateOpened"] = @YES;
  return res;
}

static NSDictionary *openGroup(NSDictionary *req, NSString *appName) {
  NSArray *labels = req[@"labels"];
  if (![labels isKindOfClass:NSArray.class] || !labels.count || !bindWindow(appName, req[@"windowMarker"])) {
    return failed(@"WINDOW_NOT_MATCHED", @"无法确认发起请求的 Chrome 窗口。请保持该窗口在前台后重试。");
  }
  AXUIElementRef win = (__bridge AXUIElementRef)targetWindow;

  // A pinned group is directly actionable only inside Chrome's SavedTabGroupBar
  // toolbar. Ordinary bookmark/tab buttons can have the same accessible name.
  phase(@"saved_toolbar");
  NSArray *bars = walkElements(win, ^BOOL(AXUIElementRef el, NSString *role) {
    return [role isEqualToString:@"AXToolbar"] && anyTextMatches(axTexts(el), @"^(Saved Tab Groups|已保存的标签页分组)$");
  }, 14, 1);
  if ([req[@"safeGrid"] boolValue] && bars.count) {
    phase(@"pinned_group");
    NSArray *pills = walkElements((__bridge AXUIElementRef)bars.firstObject, ^BOOL(AXUIElementRef el, NSString *role) {
      if (!isButtonRole(role) || isTabGroupsButton(el, role)) return NO;
      for (NSString *raw in axTexts(el)) {
        if ([labels containsObject:[raw stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet]]) return YES;
      }
      return NO;
    }, 6, 2);
    if (pills.count == 1) return openResult(pills.firstObject, @"bookmarks_bar_pill");
  }

  // Some macOS Chrome versions expose a top-level Tab Groups menu.
  NSDictionary *cocoa = openCocoaMenu(req);
  if (cocoa) return cocoa;
  if (![req[@"scopedMenu"] boolValue]) return failed(@"AMBIGUOUS_GROUP", @"Chrome 菜单中的分组标签有重名冲突，请在 Chrome 打开目标组后重试。");

  phase(@"bookmarks_grid");
  NSArray *grids = walkElements((__bridge AXUIElementRef)bars.firstObject,
    ^BOOL(AXUIElementRef el, NSString *role) { return isTabGroupsButton(el, role); }, 6, 2);
  if (grids.count == 1 && press(grids.firstObject)) {
    NSDictionary *result = openFromGroupList(req, grids.firstObject, NO);
    if (result) return result;
    escapeMenu();
  }

  phase(@"app_menu");
  NSArray *buttons = walkElements(win, ^BOOL(AXUIElementRef el, NSString *role) { return isAppMenuButton(el, role); }, 18, 2);
  if (buttons.count == 1 && press(buttons.firstObject)) {
    AXPredicate isSection = ^BOOL(AXUIElementRef el, NSString *role) { return isTabGroupsMenuItem(el, role); };
    NSArray *sections = waitForItems(nil, isSection);
    if (sections.count == 1 && hover(sections.firstObject)) {
      NSDictionary *result = openFromGroupList(req, sections.firstObject, YES);
      if (result) return result;
    }
    escapeMenu();
  }
  return failed(@"NOT_FOUND_IN_UI", @"未在请求窗口的 Chrome 标签组菜单中找到可打开的目标。请手动打开该组后在插件内继续。");
}

static NSDictionary *handleRequest(NSDictionary *req) {
  NSString *action = [req[@"action"] isKindOfClass:[NSString class]] ? req[@"action"] : @"ax_status";
  NSString *appName = [req[@"appName"] isKindOfClass:[NSString class]] && [req[@"appName"] length] > 0
    ? req[@"appName"] : @"Google Chrome";

  phase(action);
  if ([action isEqualToString:@"ax_status"]) {
    BOOL trusted = AXIsProcessTrusted();
    return @{ @"ok": @YES, @"trusted": @(trusted), @"helperName": @"PageLens Helper" };
  }

  if ([action isEqualToString:@"request_accessibility"]) {
    NSDictionary *opts = @{ (__bridge id)kAXTrustedCheckOptionPrompt: @YES };
    BOOL trusted = AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
    return @{ @"ok": @YES, @"trusted": @(trusted), @"helperName": @"PageLens Helper" };
  }

  BOOL trusted = AXIsProcessTrusted();
  if (!trusted) {
    return @{
      @"ok": ([action isEqualToString:@"diagnose"] ? @YES : @NO),
      @"trusted": @NO,
      @"code": @"ACCESSIBILITY_REQUIRED",
      @"helperName": @"PageLens Helper",
      @"error": @"未授予 PageLens Helper 的 macOS 辅助功能权限，无法操控 Chrome 原生「标签页分组」菜单。",
    };
  }

  deadlineMs = [req[@"deadlineMs"] doubleValue];
  if ([action isEqualToString:@"open"]) return openGroup(req, appName);
  if (![action isEqualToString:@"diagnose"]) return failed(@"UNKNOWN_ACTION", @"不支持的辅助功能操作。");

  NSRunningApplication *chrome = chromeApps(appName).firstObject;
  if (!chrome) {
    return @{
      @"ok": ([action isEqualToString:@"diagnose"] ? @YES : @NO),
      @"trusted": @YES,
      @"chromeRunning": @NO,
      @"error": [NSString stringWithFormat:@"未找到运行中的 %@ 进程。", appName],
    };
  }

  AXUIElementRef appEl = AXUIElementCreateApplication(chrome.processIdentifier);
  // Request Chrome's full Views accessibility tree.
  AXUIElementSetAttributeValue(appEl, CFSTR("AXEnhancedUserInterface"), kCFBooleanTrue);

  if ([action isEqualToString:@"diagnose"]) {
    sleepMs(120);
    NSUInteger winCount = 0;
    id __attribute__((objc_precise_lifetime)) windowObj = findStandardWindow(appEl, &winCount);
    AXUIElementRef win = (__bridge AXUIElementRef)windowObj;
    if (!win) {
      CFRelease(appEl);
      return @{ @"ok": @YES, @"trusted": @YES, @"chromeRunning": @YES, @"windowCount": @(winCount), @"error": @"未找到标准 Chrome 窗口。" };
    }
    NSArray *tgBtns = walkElements(win, ^BOOL(AXUIElementRef el, NSString *r) { return isTabGroupsButton(el, r); }, 18, 6);
    NSArray *appBtns = walkElements(win, ^BOOL(AXUIElementRef el, NSString *r) { return isAppMenuButton(el, r); }, 18, 4);
    NSArray *sampleEls = walkElements(win, ^BOOL(AXUIElementRef el, NSString *r) { return isButtonRole(r); }, 16, 60);

    NSMutableArray *tgList = [NSMutableArray array];
    for (id el in tgBtns) [tgList addObject:@{ @"role": axRole((__bridge AXUIElementRef)el), @"texts": axTexts((__bridge AXUIElementRef)el) }];
    NSMutableArray *appList = [NSMutableArray array];
    for (id el in appBtns) [appList addObject:@{ @"role": axRole((__bridge AXUIElementRef)el), @"texts": axTexts((__bridge AXUIElementRef)el) }];
    NSMutableArray *samples = [NSMutableArray array];
    for (id el in sampleEls) {
      NSArray<NSString *> *t = axTexts((__bridge AXUIElementRef)el);
      if (t.count > 0 && samples.count < 30) [samples addObject:t.firstObject];
    }
    NSString *winTitle = axStringAttr(win, kAXTitleAttribute) ?: @"";
    CFRelease(appEl);
    return @{
      @"ok": @YES,
      @"trusted": @YES,
      @"helperName": @"PageLens Helper",
      @"chromeRunning": @YES,
      @"windowCount": @(winCount),
      @"standardWindowTitle": winTitle,
      @"tabGroupsButtons": tgList,
      @"appMenuButtons": appList,
      @"sampleChromeButtons": samples,
    };
  }

  CFRelease(appEl);
  return failed(@"UNKNOWN_ACTION", @"不支持的辅助功能操作。");
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) {
      // Launched manually without args: trigger Accessibility prompt for PageLens Helper.
      NSDictionary *opts = @{ (__bridge id)kAXTrustedCheckOptionPrompt: @YES };
      AXIsProcessTrustedWithOptions((__bridge CFDictionaryRef)opts);
      return 0;
    }
    NSString *reqPath = [NSString stringWithUTF8String:argv[1]];
    NSString *resPath = [NSString stringWithUTF8String:argv[2]];
    phaseFile = [resPath stringByAppendingString:@".phase"];
    phase(@"process_started");
    // Check in with LaunchServices before doing any work or exiting. A very
    // short-lived command-line main can otherwise fail the open() handshake.
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyAccessory];
    phase(@"app_initialized");
    dispatch_async(dispatch_get_main_queue(), ^{
      phase(@"entered_run_loop");
      NSString *claimed = [reqPath stringByAppendingString:@".claimed"];
      if (rename(reqPath.fileSystemRepresentation, claimed.fileSystemRepresentation) == 0) {
        NSData *data = [NSData dataWithContentsOfFile:claimed];
        NSDictionary *req = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
        NSDictionary *res = [req isKindOfClass:NSDictionary.class]
          ? handleRequest(req) : failed(@"INVALID_REQUEST", @"无效的 PageLens Helper 请求。");
        NSData *output = [NSJSONSerialization dataWithJSONObject:res options:0 error:nil];
        [output writeToFile:resPath atomically:YES];
      }
      [app terminate:nil];
    });
    [app run];
  }
  return 0;
}
