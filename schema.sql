-- JBM School ERP Database Schema
-- Run this in phpMyAdmin on Hostinger

SET FOREIGN_KEY_CHECKS = 0;

-- 1. Users (admin/staff login)
CREATE TABLE IF NOT EXISTS `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `email` varchar(100) NOT NULL UNIQUE,
  `password` varchar(255) NOT NULL,
  `role` enum('admin','teacher','accountant','librarian','transport') DEFAULT 'teacher',
  `staff_id` int DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 2. Academic Years
CREATE TABLE IF NOT EXISTS `academic_years` (
  `id` int NOT NULL AUTO_INCREMENT,
  `year` varchar(20) NOT NULL,
  `is_current` tinyint(1) DEFAULT 0,
  `start_date` date DEFAULT NULL,
  `end_date` date DEFAULT NULL,
  PRIMARY KEY (`id`)
);

-- 3. Classes
CREATE TABLE IF NOT EXISTS `classes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `class_name` varchar(50) NOT NULL,
  `section` varchar(10) NOT NULL,
  `stream` varchar(50) DEFAULT NULL,
  `academic_year_id` int DEFAULT NULL,
  `class_teacher_id` int DEFAULT NULL,
  PRIMARY KEY (`id`)
);

-- 4. Students
CREATE TABLE IF NOT EXISTS `students` (
  `id` int NOT NULL AUTO_INCREMENT,
  `admission_no` varchar(50) NOT NULL UNIQUE,
  `roll_no` varchar(20) DEFAULT NULL,
  `class_id` int DEFAULT NULL,
  `academic_year_id` int DEFAULT NULL,
  `admission_date` date DEFAULT NULL,
  `status` enum('active','inactive','transferred','passed') DEFAULT 'active',
  `day_scholar` enum('Day Scholar','Boarding') DEFAULT 'Day Scholar',
  `fee_group_id` int DEFAULT NULL,
  `house` varchar(50) DEFAULT NULL,
  `first_name` varchar(100) NOT NULL,
  `middle_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) NOT NULL,
  `gender` enum('Male','Female','Other') NOT NULL,
  `dob` date DEFAULT NULL,
  `aadhar_no` varchar(20) DEFAULT NULL,
  `blood_group` varchar(10) DEFAULT NULL,
  `religion` varchar(50) DEFAULT NULL,
  `category` enum('General','OBC','SC','ST','EWS','OTHER') DEFAULT 'General',
  `email` varchar(100) DEFAULT NULL,
  `nationality` varchar(50) DEFAULT 'Indian',
  `srn_no` varchar(50) DEFAULT NULL,
  `child_id` varchar(50) DEFAULT NULL,
  `samagra_id` varchar(50) DEFAULT NULL,
  `place_of_birth` varchar(100) DEFAULT NULL,
  `caste` varchar(50) DEFAULT NULL,
  `apaar_id` varchar(50) DEFAULT NULL,
  `height_cm` decimal(5,2) DEFAULT NULL,
  `weight_kg` decimal(5,2) DEFAULT NULL,
  `mother_tongue` varchar(50) DEFAULT NULL,
  `medical_condition` text DEFAULT NULL,
  `notes` text DEFAULT NULL,
  `is_special_child` tinyint(1) DEFAULT 0,
  `is_ews` tinyint(1) DEFAULT 0,
  `pen_no` varchar(50) DEFAULT NULL,
  `is_physically_disabled` tinyint(1) DEFAULT 0,
  `disability_details` text DEFAULT NULL,
  `photo` varchar(255) DEFAULT NULL,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 5. Parents
CREATE TABLE IF NOT EXISTS `parents` (
  `id` int NOT NULL AUTO_INCREMENT,
  `student_id` int NOT NULL,
  `type` enum('father','mother','guardian') NOT NULL,
  `salutation` varchar(10) DEFAULT NULL,
  `first_name` varchar(100) DEFAULT NULL,
  `middle_name` varchar(100) DEFAULT NULL,
  `last_name` varchar(100) DEFAULT NULL,
  `email` varchar(100) DEFAULT NULL,
  `mobile` varchar(15) DEFAULT NULL,
  `sms_whatsapp_no` varchar(15) DEFAULT NULL,
  `qualification` varchar(100) DEFAULT NULL,
  `occupation` varchar(100) DEFAULT NULL,
  `income_per_year` decimal(12,2) DEFAULT NULL,
  `department` varchar(100) DEFAULT NULL,
  `designation` varchar(100) DEFAULT NULL,
  `aadhar_no` varchar(20) DEFAULT NULL,
  `pan_no` varchar(20) DEFAULT NULL,
  `company_name` varchar(200) DEFAULT NULL,
  `relation` varchar(50) DEFAULT NULL,
  `photo` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `student_id` (`student_id`)
);

-- 6. Student Addresses
CREATE TABLE IF NOT EXISTS `student_addresses` (
  `id` int NOT NULL AUTO_INCREMENT,
  `student_id` int NOT NULL,
  `type` enum('present','permanent') NOT NULL,
  `address` text DEFAULT NULL,
  `state` varchar(100) DEFAULT NULL,
  `city` varchar(100) DEFAULT NULL,
  `district` varchar(100) DEFAULT NULL,
  `taluka` varchar(100) DEFAULT NULL,
  `pin_code` varchar(10) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `student_id` (`student_id`)
);

-- 7. Student Bank Details
CREATE TABLE IF NOT EXISTS `student_bank` (
  `id` int NOT NULL AUTO_INCREMENT,
  `student_id` int NOT NULL UNIQUE,
  `bank_name` varchar(100) DEFAULT NULL,
  `account_holder` varchar(100) DEFAULT NULL,
  `account_type` enum('Savings','Current') DEFAULT 'Savings',
  `account_no` varchar(50) DEFAULT NULL,
  `ifsc_code` varchar(20) DEFAULT NULL,
  `micr_no` varchar(20) DEFAULT NULL,
  `branch_name` varchar(100) DEFAULT NULL,
  PRIMARY KEY (`id`)
);

-- 8. Student Documents
CREATE TABLE IF NOT EXISTS `student_documents` (
  `id` int NOT NULL AUTO_INCREMENT,
  `student_id` int NOT NULL,
  `doc_name` varchar(100) NOT NULL,
  `file_path` varchar(255) NOT NULL,
  `uploaded_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 9. Previous School Details
CREATE TABLE IF NOT EXISTS `previous_school` (
  `id` int NOT NULL AUTO_INCREMENT,
  `student_id` int NOT NULL UNIQUE,
  `school_name` varchar(200) DEFAULT NULL,
  `school_class` varchar(50) DEFAULT NULL,
  `date_of_leaving` date DEFAULT NULL,
  `tc_number` varchar(50) DEFAULT NULL,
  `udise_code` varchar(50) DEFAULT NULL,
  `affiliation_no` varchar(50) DEFAULT NULL,
  `days_attended` int DEFAULT NULL,
  `marks_obtained` varchar(50) DEFAULT NULL,
  `roll_no` varchar(50) DEFAULT NULL,
  `admission_no` varchar(50) DEFAULT NULL,
  PRIMARY KEY (`id`)
);

-- 10. Staff
CREATE TABLE IF NOT EXISTS `staff` (
  `id` int NOT NULL AUTO_INCREMENT,
  `staff_code` varchar(50) DEFAULT NULL,
  `first_name` varchar(100) NOT NULL,
  `last_name` varchar(100) NOT NULL,
  `gender` enum('Male','Female','Other') DEFAULT NULL,
  `dob` date DEFAULT NULL,
  `email` varchar(100) DEFAULT NULL,
  `phone` varchar(15) DEFAULT NULL,
  `designation` varchar(100) DEFAULT NULL,
  `department` varchar(100) DEFAULT NULL,
  `staff_type` enum('Teaching','Non-Teaching') DEFAULT 'Teaching',
  `employment_type` enum('Permanent','Contractual','Part-Time') DEFAULT 'Permanent',
  `role` varchar(50) DEFAULT NULL,
  `house` varchar(50) DEFAULT NULL,
  `joining_date` date DEFAULT NULL,
  `aadhar_no` varchar(20) DEFAULT NULL,
  `pan_no` varchar(20) DEFAULT NULL,
  `qualification` varchar(200) DEFAULT NULL,
  `experience` varchar(100) DEFAULT NULL,
  `address` text DEFAULT NULL,
  `photo` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 11. Fee Heads
CREATE TABLE IF NOT EXISTS `fee_heads` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `description` text DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`)
);

-- 12. Fee Groups
CREATE TABLE IF NOT EXISTS `fee_groups` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL,
  `class_id` int DEFAULT NULL,
  `description` text DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`)
);

-- 13. Fee Group Details
CREATE TABLE IF NOT EXISTS `fee_group_details` (
  `id` int NOT NULL AUTO_INCREMENT,
  `fee_group_id` int NOT NULL,
  `fee_head_id` int NOT NULL,
  `amount` decimal(10,2) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`)
);

-- 14. Fee Installments
CREATE TABLE IF NOT EXISTS `fee_installments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `fee_group_id` int NOT NULL,
  `name` varchar(100) NOT NULL,
  `due_date` date DEFAULT NULL,
  `amount` decimal(10,2) DEFAULT 0,
  PRIMARY KEY (`id`)
);

-- 15. Fee Payments
CREATE TABLE IF NOT EXISTS `fee_payments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `student_id` int NOT NULL,
  `fee_group_id` int DEFAULT NULL,
  `installment_id` int DEFAULT NULL,
  `amount_paid` decimal(10,2) NOT NULL,
  `payment_date` date NOT NULL,
  `payment_mode` enum('Cash','Cheque','Online','UPI','DD') DEFAULT 'Cash',
  `receipt_no` varchar(50) DEFAULT NULL,
  `transaction_id` varchar(100) DEFAULT NULL,
  `remarks` text DEFAULT NULL,
  `collected_by` int DEFAULT NULL,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 16. Fee Concessions
CREATE TABLE IF NOT EXISTS `fee_concessions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `student_id` int NOT NULL,
  `fee_head_id` int DEFAULT NULL,
  `concession_type` enum('Percentage','Fixed') DEFAULT 'Fixed',
  `amount` decimal(10,2) DEFAULT 0,
  `reason` text DEFAULT NULL,
  `approved_by` int DEFAULT NULL,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 17. Student Attendance
CREATE TABLE IF NOT EXISTS `attendance_student` (
  `id` int NOT NULL AUTO_INCREMENT,
  `student_id` int NOT NULL,
  `class_id` int DEFAULT NULL,
  `date` date NOT NULL,
  `status` enum('Present','Absent','Late','Leave') DEFAULT 'Present',
  `remarks` varchar(255) DEFAULT NULL,
  `marked_by` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `student_date` (`student_id`, `date`)
);

-- 18. Staff Attendance
CREATE TABLE IF NOT EXISTS `attendance_staff` (
  `id` int NOT NULL AUTO_INCREMENT,
  `staff_id` int NOT NULL,
  `date` date NOT NULL,
  `in_time` time DEFAULT NULL,
  `out_time` time DEFAULT NULL,
  `status` enum('Present','Absent','Late','Leave','Holiday') DEFAULT 'Present',
  `remarks` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `staff_date` (`staff_id`, `date`)
);

-- 19. Leave Requests
CREATE TABLE IF NOT EXISTS `leave_requests` (
  `id` int NOT NULL AUTO_INCREMENT,
  `type` enum('student','staff') NOT NULL,
  `person_id` int NOT NULL,
  `from_date` date NOT NULL,
  `to_date` date NOT NULL,
  `reason` text DEFAULT NULL,
  `status` enum('Pending','Approved','Rejected') DEFAULT 'Pending',
  `approved_by` int DEFAULT NULL,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 20. Admissions/Registrations
CREATE TABLE IF NOT EXISTS `admissions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `enquiry_no` varchar(50) DEFAULT NULL,
  `student_name` varchar(200) NOT NULL,
  `class_applied` varchar(50) DEFAULT NULL,
  `father_name` varchar(200) DEFAULT NULL,
  `father_mobile` varchar(15) DEFAULT NULL,
  `mother_name` varchar(200) DEFAULT NULL,
  `email` varchar(100) DEFAULT NULL,
  `address` text DEFAULT NULL,
  `enquiry_date` date DEFAULT NULL,
  `status` enum('Enquiry','Registered','Admitted','Cancelled') DEFAULT 'Enquiry',
  `remarks` text DEFAULT NULL,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 21. Library Books
CREATE TABLE IF NOT EXISTS `library_books` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `author` varchar(200) DEFAULT NULL,
  `isbn` varchar(50) DEFAULT NULL,
  `publisher` varchar(200) DEFAULT NULL,
  `category` varchar(100) DEFAULT NULL,
  `total_copies` int DEFAULT 1,
  `available_copies` int DEFAULT 1,
  `price` decimal(10,2) DEFAULT NULL,
  `rack_no` varchar(20) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`)
);

-- 22. Library Issues
CREATE TABLE IF NOT EXISTS `library_issues` (
  `id` int NOT NULL AUTO_INCREMENT,
  `book_id` int NOT NULL,
  `borrower_type` enum('student','staff') DEFAULT 'student',
  `borrower_id` int NOT NULL,
  `issue_date` date NOT NULL,
  `due_date` date DEFAULT NULL,
  `return_date` date DEFAULT NULL,
  `fine` decimal(10,2) DEFAULT 0,
  `status` enum('Issued','Returned','Overdue') DEFAULT 'Issued',
  PRIMARY KEY (`id`)
);

-- 23. Transport Routes
CREATE TABLE IF NOT EXISTS `transport_routes` (
  `id` int NOT NULL AUTO_INCREMENT,
  `route_name` varchar(100) NOT NULL,
  `start_point` varchar(200) DEFAULT NULL,
  `end_point` varchar(200) DEFAULT NULL,
  `stops` text DEFAULT NULL,
  `distance_km` decimal(8,2) DEFAULT NULL,
  `fee_amount` decimal(10,2) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`)
);

-- 24. Transport Vehicles
CREATE TABLE IF NOT EXISTS `transport_vehicles` (
  `id` int NOT NULL AUTO_INCREMENT,
  `vehicle_no` varchar(50) NOT NULL,
  `vehicle_type` varchar(50) DEFAULT NULL,
  `driver_name` varchar(100) DEFAULT NULL,
  `driver_mobile` varchar(15) DEFAULT NULL,
  `capacity` int DEFAULT NULL,
  `route_id` int DEFAULT NULL,
  `certificate_expiry` date DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`)
);

-- 25. Transport Allocation
CREATE TABLE IF NOT EXISTS `transport_allocation` (
  `id` int NOT NULL AUTO_INCREMENT,
  `student_id` int NOT NULL,
  `vehicle_id` int DEFAULT NULL,
  `route_id` int DEFAULT NULL,
  `pickup_point` varchar(200) DEFAULT NULL,
  `academic_year_id` int DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`)
);

-- 26. Hostel Rooms
CREATE TABLE IF NOT EXISTS `hostel_rooms` (
  `id` int NOT NULL AUTO_INCREMENT,
  `room_no` varchar(20) NOT NULL,
  `room_type` varchar(50) DEFAULT NULL,
  `floor` varchar(20) DEFAULT NULL,
  `capacity` int DEFAULT 1,
  `occupied` int DEFAULT 0,
  `monthly_fee` decimal(10,2) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`)
);

-- 27. Hostel Allocation
CREATE TABLE IF NOT EXISTS `hostel_allocation` (
  `id` int NOT NULL AUTO_INCREMENT,
  `student_id` int NOT NULL,
  `room_id` int DEFAULT NULL,
  `from_date` date DEFAULT NULL,
  `to_date` date DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`)
);

-- 28. Salary Structure
CREATE TABLE IF NOT EXISTS `salary_structure` (
  `id` int NOT NULL AUTO_INCREMENT,
  `staff_id` int NOT NULL,
  `basic_salary` decimal(12,2) DEFAULT 0,
  `hra` decimal(12,2) DEFAULT 0,
  `da` decimal(12,2) DEFAULT 0,
  `ta` decimal(12,2) DEFAULT 0,
  `other_allowance` decimal(12,2) DEFAULT 0,
  `pf_deduction` decimal(12,2) DEFAULT 0,
  `esi_deduction` decimal(12,2) DEFAULT 0,
  `tds_deduction` decimal(12,2) DEFAULT 0,
  `other_deduction` decimal(12,2) DEFAULT 0,
  `effective_from` date DEFAULT NULL,
  PRIMARY KEY (`id`)
);

-- 29. Salary Payments
CREATE TABLE IF NOT EXISTS `salary_payments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `staff_id` int NOT NULL,
  `month` int NOT NULL,
  `year` int NOT NULL,
  `gross_salary` decimal(12,2) DEFAULT 0,
  `total_deductions` decimal(12,2) DEFAULT 0,
  `net_salary` decimal(12,2) DEFAULT 0,
  `payment_date` date DEFAULT NULL,
  `payment_mode` enum('Cash','Bank Transfer','Cheque') DEFAULT 'Bank Transfer',
  `status` enum('Pending','Paid') DEFAULT 'Pending',
  `remarks` text DEFAULT NULL,
  PRIMARY KEY (`id`)
);

-- 30. Timetable
CREATE TABLE IF NOT EXISTS `timetable` (
  `id` int NOT NULL AUTO_INCREMENT,
  `class_id` int NOT NULL,
  `day` enum('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday') NOT NULL,
  `period_no` int NOT NULL,
  `start_time` time DEFAULT NULL,
  `end_time` time DEFAULT NULL,
  `subject` varchar(100) DEFAULT NULL,
  `staff_id` int DEFAULT NULL,
  `academic_year_id` int DEFAULT NULL,
  PRIMARY KEY (`id`)
);

-- 31. Notices
CREATE TABLE IF NOT EXISTS `notices` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `content` text DEFAULT NULL,
  `for_class` varchar(50) DEFAULT 'All',
  `for_type` enum('student','staff','all') DEFAULT 'all',
  `publish_date` date DEFAULT NULL,
  `expiry_date` date DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 32. Events
CREATE TABLE IF NOT EXISTS `events` (
  `id` int NOT NULL AUTO_INCREMENT,
  `title` varchar(255) NOT NULL,
  `description` text DEFAULT NULL,
  `event_date` date DEFAULT NULL,
  `event_time` time DEFAULT NULL,
  `venue` varchar(200) DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 33. SMS Log
CREATE TABLE IF NOT EXISTS `sms_log` (
  `id` int NOT NULL AUTO_INCREMENT,
  `to_number` varchar(15) NOT NULL,
  `message` text NOT NULL,
  `type` enum('SMS','WhatsApp') DEFAULT 'SMS',
  `status` enum('Sent','Failed','Pending') DEFAULT 'Pending',
  `sent_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 34. Accounts Transactions
CREATE TABLE IF NOT EXISTS `accounts_transactions` (
  `id` int NOT NULL AUTO_INCREMENT,
  `type` enum('Income','Expense') NOT NULL,
  `category` varchar(100) DEFAULT NULL,
  `amount` decimal(12,2) NOT NULL,
  `date` date NOT NULL,
  `description` text DEFAULT NULL,
  `payment_mode` enum('Cash','Cheque','Online','UPI') DEFAULT 'Cash',
  `reference_no` varchar(100) DEFAULT NULL,
  `created_by` int DEFAULT NULL,
  `created_at` timestamp DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);

-- 35. Inventory
CREATE TABLE IF NOT EXISTS `inventory` (
  `id` int NOT NULL AUTO_INCREMENT,
  `item_name` varchar(200) NOT NULL,
  `category` varchar(100) DEFAULT NULL,
  `quantity` int DEFAULT 0,
  `unit` varchar(20) DEFAULT NULL,
  `unit_price` decimal(10,2) DEFAULT NULL,
  `total_value` decimal(12,2) DEFAULT NULL,
  `vendor` varchar(200) DEFAULT NULL,
  `purchase_date` date DEFAULT NULL,
  `location` varchar(100) DEFAULT NULL,
  `is_active` tinyint(1) DEFAULT 1,
  PRIMARY KEY (`id`)
);

-- 36. Configuration
CREATE TABLE IF NOT EXISTS `configuration` (
  `id` int NOT NULL AUTO_INCREMENT,
  `key_name` varchar(100) NOT NULL UNIQUE,
  `value` text DEFAULT NULL,
  `description` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`)
);

-- 37. Working Days
CREATE TABLE IF NOT EXISTS `working_days` (
  `id` int NOT NULL AUTO_INCREMENT,
  `academic_year_id` int DEFAULT NULL,
  `month` int NOT NULL,
  `year` int NOT NULL,
  `total_working_days` int DEFAULT 0,
  `class_id` int DEFAULT NULL,
  PRIMARY KEY (`id`)
);

SET FOREIGN_KEY_CHECKS = 1;

-- Default admin user (password: admin123)
INSERT IGNORE INTO `users` (`name`, `email`, `password`, `role`) VALUES
('Administrator', 'admin@jbmps.com', '$2a$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', 'admin');

-- Default academic year
INSERT IGNORE INTO `academic_years` (`year`, `is_current`, `start_date`, `end_date`) VALUES
('2026-2027', 1, '2026-04-01', '2027-03-31');

-- Default classes for JBM School
INSERT IGNORE INTO `classes` (`class_name`, `section`, `academic_year_id`) VALUES
('Nursery', 'Indus', 1), ('Nursery', 'Kaveri', 1), ('Nursery', 'Narmada', 1),
('Prep', 'Indus', 1), ('Prep', 'Kaveri', 1), ('Prep', 'Narmada', 1),
('I', 'Indus', 1), ('I', 'Kaveri', 1), ('I', 'Narmada', 1),
('II', 'Indus', 1), ('II', 'Kaveri', 1), ('II', 'Narmada', 1),
('III', 'Indus', 1), ('III', 'Kaveri', 1), ('III', 'Narmada', 1),
('IV', 'Indus', 1), ('IV', 'Kaveri', 1), ('IV', 'Narmada', 1),
('V', 'Indus', 1), ('V', 'Kaveri', 1), ('V', 'Narmada', 1),
('VI', 'Indus', 1), ('VI', 'Kaveri', 1), ('VI', 'Narmada', 1),
('VII', 'Indus', 1), ('VII', 'Kaveri', 1), ('VII', 'Narmada', 1),
('VIII', 'Indus', 1), ('VIII', 'Kaveri', 1), ('VIII', 'Narmada', 1),
('IX', 'Indus', 1), ('IX', 'Kaveri', 1), ('IX', 'Narmada', 1),
('X', 'Indus', 1), ('X', 'Kaveri', 1), ('X', 'Narmada', 1),
('XI', 'Arts', 1), ('XI', 'Commerce', 1), ('XI', 'Science', 1), ('XI', 'SCI A', 1),
('XII', 'Arts', 1), ('XII', 'Commerce', 1), ('XII', 'Science', 1), ('XII', 'SCI A', 1);

-- Default configuration
INSERT IGNORE INTO `configuration` (`key_name`, `value`, `description`) VALUES
('school_name', 'JBM Public School', 'School Name'),
('school_code', 'JBMPS', 'School Code'),
('school_address', 'Your Address Here', 'School Address'),
('school_phone', '', 'School Phone'),
('school_email', 'info@jbmpschool.com', 'School Email'),
('academic_year', '2026-2027', 'Current Academic Year'),
('currency', 'INR', 'Currency'),
('date_format', 'DD-MM-YYYY', 'Date Format');

-- Default fee heads
INSERT IGNORE INTO `fee_heads` (`name`) VALUES
('Tuition Fee'), ('Annual Charges'), ('Examination Fee'),
('Sports Fee'), ('Lab Fee'), ('Library Fee'),
('Transport Fee'), ('Computer Fee'), ('Development Fee');
