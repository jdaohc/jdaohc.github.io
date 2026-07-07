export const OPINION_RULES = {
  minScore: 40,
  scoreLevels: [
    { min: 80, label: "\u9ad8\u8206\u60c5\u4ef7\u503c" },
    { min: 60, label: "\u8f83\u9ad8\u8206\u60c5\u4ef7\u503c" },
    { min: 40, label: "\u4e00\u822c\u8206\u60c5\u4ef7\u503c" }
  ],
  entertainmentKeywords: [
    "\u660e\u661f", "\u604b\u60c5", "\u79bb\u5a5a", "\u673a\u573a\u56fe", "\u7ea2\u6bef", "\u7efc\u827a", "\u7535\u5f71",
    "\u7535\u89c6\u5267", "\u77ed\u5267", "\u65b0\u6b4c", "\u4ee3\u8a00", "\u5076\u50cf", "\u996d\u5708",
    "\u7c89\u4e1d", "\u5e94\u63f4", "\u7968\u623f", "\u8def\u900f", "\u5b98\u5ba3", "\u70ed\u64ad"
  ],
  foreignKeywords: [
    "\u7f8e\u56fd", "\u82f1\u56fd", "\u65e5\u672c", "\u97e9\u56fd", "\u5370\u5ea6", "\u6cd5\u56fd", "\u5fb7\u56fd",
    "\u4fc4\u7f57\u65af", "\u4e4c\u514b\u5170", "\u4ee5\u8272\u5217", "\u4f0a\u6717", "\u6b27\u6d32",
    "\u6d77\u5916", "\u56fd\u5916", "\u5916\u5a92", "FIFA", "\u4e16\u754c\u676f", "\u6b27\u8db3\u8054"
  ],
  domesticImpactKeywords: [
    "\u4e2d\u56fd", "\u56fd\u5185", "\u6211\u56fd", "\u4e2d\u65b9", "\u4e2d\u56fd\u516c\u6c11",
    "\u4e2d\u56fd\u4f01\u4e1a", "\u4e2d\u56fd\u7ecf\u6d4e", "\u8fdb\u53e3", "\u51fa\u53e3",
    "\u7559\u5b66", "\u7b7e\u8bc1", "\u822a\u73ed", "\u4f9b\u5e94\u94fe", "\u6d77\u5173"
  ],
  opinionKeywords: [
    "\u793e\u4f1a", "\u6c11\u751f", "\u6559\u80b2", "\u533b\u7597", "\u5c31\u4e1a", "\u98df\u54c1\u5b89\u5168",
    "\u6d88\u8d39", "\u7ef4\u6743", "\u4ea4\u901a", "\u4f4f\u623f", "\u623f\u5730\u4ea7", "\u6cd5\u5f8b",
    "\u6848\u4ef6", "\u516c\u5171\u5b89\u5168", "\u653f\u7b56", "\u6821\u56ed", "\u52b3\u52a8",
    "\u707e\u5bb3", "\u73af\u5883", "\u7f51\u7edc\u6cbb\u7406", "\u672a\u6210\u5e74\u4eba",
    "\u8001\u5e74\u4eba", "\u5987\u5973", "\u8bc8\u9a97", "\u4ea7\u54c1\u8d28\u91cf", "\u4f01\u4e1a",
    "\u901a\u62a5", "\u8f9f\u8c23", "\u5904\u7f5a", "\u4e8b\u6545", "\u6d2a\u6c34", "\u66b4\u96e8",
    "\u53f0\u98ce", "\u706b\u707e", "\u5730\u9707", "\u6b7b\u4ea1", "\u6551\u63f4", "\u6295\u8bc9",
    "\u8c03\u67e5", "\u76d1\u7ba1", "\u516c\u5b89", "\u6cd5\u9662", "\u68c0\u5bdf"
  ],
  categories: [
    { name: "\u6559\u80b2", keywords: ["\u5b66\u6821", "\u5b66\u751f", "\u8001\u5e08", "\u9ad8\u8003", "\u4e2d\u8003", "\u6559\u80b2", "\u6821\u56ed"] },
    { name: "\u533b\u7597", keywords: ["\u533b\u9662", "\u533b\u751f", "\u62a4\u58eb", "\u60a3\u8005", "\u533b\u7597", "\u533b\u4fdd", "\u836f"] },
    { name: "\u5c31\u4e1a", keywords: ["\u5c31\u4e1a", "\u62db\u8058", "\u88c1\u5458", "\u5931\u4e1a", "\u804c\u573a"] },
    { name: "\u98df\u54c1\u5b89\u5168", keywords: ["\u98df\u54c1", "\u9910\u996e", "\u5916\u5356", "\u6bd2", "\u536b\u751f"] },
    { name: "\u6d88\u8d39", keywords: ["\u6d88\u8d39", "\u7ef4\u6743", "\u6295\u8bc9", "\u9000\u6b3e", "\u4ef7\u683c", "\u6536\u8d39", "\u4ea7\u54c1\u8d28\u91cf"] },
    { name: "\u4ea4\u901a", keywords: ["\u4ea4\u901a", "\u5730\u94c1", "\u516c\u4ea4", "\u94c1\u8def", "\u9ad8\u901f", "\u822a\u73ed", "\u8f66\u7978"] },
    { name: "\u4f4f\u623f", keywords: ["\u4f4f\u623f", "\u623f\u4ef7", "\u623f\u79df", "\u623f\u5730\u4ea7", "\u7269\u4e1a", "\u70c2\u5c3e"] },
    { name: "\u6cd5\u5f8b", keywords: ["\u6cd5\u9662", "\u68c0\u5bdf", "\u5224\u51b3", "\u7acb\u6848", "\u6848\u4ef6", "\u8fdd\u6cd5", "\u72af\u7f6a", "\u5904\u7f5a"] },
    { name: "\u516c\u5171\u5b89\u5168", keywords: ["\u516c\u5171\u5b89\u5168", "\u4e8b\u6545", "\u706b\u707e", "\u7206\u70b8", "\u6b7b\u4ea1", "\u6551\u63f4"] },
    { name: "\u653f\u7b56", keywords: ["\u653f\u7b56", "\u56fd\u52a1\u9662", "\u90e8\u95e8", "\u89c4\u5212", "\u6761\u4f8b", "\u901a\u77e5"] },
    { name: "\u52b3\u52a8", keywords: ["\u52b3\u52a8", "\u6b20\u85aa", "\u5de5\u8d44", "\u5de5\u4eba", "\u52a0\u73ed"] },
    { name: "\u707e\u5bb3", keywords: ["\u66b4\u96e8", "\u6d2a\u6c34", "\u53f0\u98ce", "\u5730\u9707", "\u5c71\u4f53\u6ed1\u5761", "\u707e\u5bb3", "\u6551\u707e"] },
    { name: "\u73af\u5883", keywords: ["\u73af\u5883", "\u6c61\u67d3", "\u751f\u6001", "\u6392\u6c61", "\u73af\u4fdd"] },
    { name: "\u7f51\u7edc\u6cbb\u7406", keywords: ["\u7f51\u7edc", "\u8c23\u8a00", "\u8f9f\u8c23", "\u8bc8\u9a97", "\u4e2a\u4eba\u4fe1\u606f", "\u5e73\u53f0"] },
    { name: "\u4f01\u4e1a\u8206\u60c5", keywords: ["\u4f01\u4e1a", "\u516c\u53f8", "\u54c1\u724c", "\u5e73\u53f0", "\u8d28\u91cf", "\u9053\u6b49"] },
    { name: "\u6c11\u751f", keywords: ["\u6c11\u751f", "\u8001\u4eba", "\u513f\u7ae5", "\u672a\u6210\u5e74\u4eba", "\u5987\u5973", "\u5c45\u6c11", "\u7fa4\u4f17"] },
    { name: "\u793e\u4f1a", keywords: ["\u793e\u4f1a", "\u7f51\u53cb", "\u901a\u62a5", "\u56de\u5e94", "\u8c03\u67e5", "\u57ce\u5e02\u6cbb\u7406"] }
  ],
  scoring: {
    base: 10,
    rank: [
      { max: 3, points: 22 },
      { max: 10, points: 16 },
      { max: 30, points: 10 },
      { max: 100, points: 5 }
    ],
    heat: [
      { min: 10000000, points: 16 },
      { min: 1000000, points: 10 },
      { min: 100000, points: 6 }
    ],
    categoryBonus: 14,
    highConcernBonus: 10,
    multiPlatformBonus: 12,
    durationHourBonus: 2,
    maxDurationBonus: 12
  },
  highConcernCategories: ["\u516c\u5171\u5b89\u5168", "\u6559\u80b2", "\u533b\u7597", "\u98df\u54c1\u5b89\u5168", "\u6d88\u8d39", "\u707e\u5bb3", "\u7f51\u7edc\u6cbb\u7406"]
};
