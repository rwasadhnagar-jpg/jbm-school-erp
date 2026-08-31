function pickTemplate({ name, subject, marksPct, attendancePct }) {
  const m = marksPct == null ? 0 : marksPct;
  const a = attendancePct == null ? 0 : attendancePct;

  if (m >= 90 && a >= 90) {
    return `${name} has performed outstandingly in ${subject} this term, scoring ${m}% with excellent attendance of ${a}%. A consistent, dedicated learner who sets a great example for the class.`;
  }
  if (m >= 75 && a >= 85) {
    return `${name} has done very well in ${subject} this term, scoring ${m}% with good attendance of ${a}%. Continued focus and practice will help push these results even higher.`;
  }
  if (m >= 60 && a >= 75) {
    return `${name} has shown satisfactory progress in ${subject} this term, scoring ${m}% with attendance of ${a}%. Regular revision and more consistent classroom participation are recommended.`;
  }
  if (m >= 40 || a >= 60) {
    return `${name} needs improvement in ${subject} this term, having scored ${m}% with attendance of ${a}%. Extra practice at home and closer attention in class are strongly recommended.`;
  }
  return `${name} requires urgent attention in ${subject} this term, scoring ${m}% with attendance of only ${a}%. We recommend a meeting with parents to discuss additional support for ${name}.`;
}

module.exports = { pickTemplate };
